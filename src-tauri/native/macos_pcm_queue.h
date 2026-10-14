#ifndef AK_MACOS_PCM_QUEUE_H
#define AK_MACOS_PCM_QUEUE_H

#include <stdbool.h>
#include <stdint.h>
#include <stdatomic.h>
#include <string.h>
#include <math.h>

// One producer (the Bluetooth queue) and one consumer (Core Audio). Neither
// side waits for the other; the render callback allocates and logs nothing.
enum { AKPCMCapacity = 4096, AKPCMPrebuffer = 480, AKPCMFade = 32,
       AKStretchHop = 160, AKStretchSearch = 80, AKStretchPrebuffer = 960 };
// Consumer-owned WSOLA state. Configuration changes require a stopped engine.
typedef struct {
    float tail[AKStretchHop], output[AKStretchHop];
    size_t offset, length, advance, tailOffset;
    float rate, fraction;
    bool haveTail;
} AKPCMStretch;
typedef struct {
    float samples[AKPCMCapacity];
    atomic_uint_fast64_t written;
    atomic_uint_fast64_t read;
    atomic_uint_fast64_t underruns;
    atomic_bool draining;
    bool primed;
    float envelope;
    bool stretchEnabled;
    AKPCMStretch stretch;
    atomic_uint stretchRatePermille;
    atomic_uint_fast64_t stretchOutputSamples;
} AKPCMQueue;

static void AKPCMQueueInit(AKPCMQueue *queue) {
    memset(queue->samples, 0, sizeof(queue->samples));
    atomic_init(&queue->written, 0);
    atomic_init(&queue->read, 0);
    atomic_init(&queue->underruns, 0);
    atomic_init(&queue->draining, false);
    queue->primed = false;
    queue->envelope = 0;
    queue->stretchEnabled = false;
    memset(&queue->stretch, 0, sizeof(queue->stretch));
    queue->stretch.rate = 1;
    atomic_init(&queue->stretchRatePermille, 1000);
    atomic_init(&queue->stretchOutputSamples, 0);
}

static size_t AKPCMQueueCount(AKPCMQueue *queue) {
    uint64_t read = atomic_load_explicit(&queue->read, memory_order_acquire);
    return (size_t)(atomic_load_explicit(&queue->written, memory_order_acquire) - read);
}

static bool AKPCMQueuePush(AKPCMQueue *queue, const int16_t *samples, size_t count,
                           float gain, size_t *clipped) {
    uint64_t written = atomic_load_explicit(&queue->written, memory_order_relaxed);
    uint64_t read = atomic_load_explicit(&queue->read, memory_order_acquire);
    if (count > AKPCMCapacity - (written - read)) return false;
    for (size_t i = 0; i < count; i++) {
        float value = (float)samples[i] / 32768.0f * gain;
        if (value > 1.0f) { value = 1.0f; (*clipped)++; }
        if (value < -1.0f) { value = -1.0f; (*clipped)++; }
        queue->samples[(written + i) % AKPCMCapacity] = value;
    }
    atomic_store_explicit(&queue->written, written + count, memory_order_release);
    return true;
}

static size_t AKPCMQueueRenderPlain(AKPCMQueue *queue, float *output, size_t count) {
    memset(output, 0, count * sizeof(float));
    uint64_t read = atomic_load_explicit(&queue->read, memory_order_relaxed);
    uint64_t written = atomic_load_explicit(&queue->written, memory_order_acquire);
    size_t available = (size_t)(written - read);
    bool draining = atomic_load_explicit(&queue->draining, memory_order_acquire);
    if (!queue->primed) {
        if (available == 0 || (!draining && available < AKPCMPrebuffer)) return 0;
        queue->primed = true;
        queue->envelope = 0;
    }
    size_t consumed = available < count ? available : count;
    for (size_t i = 0; i < consumed; i++) {
        float value = queue->samples[(read + i) % AKPCMCapacity];
        // Fade into resumed packets and towards zero before an underrun.
        // Slew back up if another packet arrives during the fade.
        size_t remaining = available - i - 1;
        float target = remaining < AKPCMFade ? (float)remaining / AKPCMFade : 1.0f;
        float rising = queue->envelope + 1.0f / AKPCMFade;
        queue->envelope = target < rising ? target : rising;
        value *= queue->envelope;
        output[i] = value;
    }
    atomic_store_explicit(&queue->read, read + consumed, memory_order_release);
    if (consumed == available) {
        queue->primed = false;
        if (!draining) atomic_fetch_add_explicit(&queue->underruns, 1, memory_order_relaxed);
    }
    return consumed;
}

// 10 ms synthesis hops, with a 10 ms overlap and a bounded 5 ms alignment
// search. Only the nominal analysis hop controls consumption: correlation must
// never lock onto a period and stop advancing through the input. No allocation,
// locks, clock queries, or logging are allowed on this render path.
static size_t AKPCMQueueRenderStretch(AKPCMQueue *queue, float *output, size_t count) {
    memset(output, 0, count * sizeof(float));
    AKPCMStretch *s = &queue->stretch;
    size_t produced = 0;
    while (produced < count) {
        uint64_t read = atomic_load_explicit(&queue->read, memory_order_relaxed);
        if (s->offset == s->length) {
            s->offset = s->length = 0;
            uint64_t written = atomic_load_explicit(&queue->written, memory_order_acquire);
            size_t available = (size_t)(written - read);
            bool draining = atomic_load_explicit(&queue->draining, memory_order_acquire);
            if (!queue->primed) {
                if (!available || (!draining && available < AKStretchPrebuffer)) break;
                queue->primed = true;
                queue->envelope = 0;
                s->haveTail = false;
                s->fraction = 0;
                s->rate = 1;
            }
            if (available < 2 * AKStretchHop + AKStretchSearch) {
                if (draining) {
                    // Flush even a sub-hop final packet. Crossfade the previous
                    // overlap into the real tail; never synthesize after EOF.
                    size_t n = AKPCMQueueRenderPlain(queue, output + produced, count - produced);
                    if (s->haveTail) {
                        for (size_t i = 0; i < n && s->tailOffset + i < AKStretchHop; i++) {
                            size_t index = s->tailOffset + i;
                            float mix = (float)index / AKStretchHop;
                            float value = s->tail[index] * (1 - mix) + output[produced + i] * mix;
                            output[produced + i] = value * fminf(1, (float)(available - i - 1) / AKPCMFade);
                        }
                        s->tailOffset += n;
                    }
                    produced += n;
                    if (s->tailOffset >= AKStretchHop) s->haveTail = false;
                    if (AKPCMQueueCount(queue) == 0) {
                        queue->primed = false;
                        s->haveTail = false;
                    }
                    break;
                }
                // A sustained outage still becomes silence and re-primes.
                queue->primed = false;
                s->haveTail = false;
                atomic_fetch_add_explicit(&queue->underruns, 1, memory_order_relaxed);
                break;
            }
            // Queue feedback settles near the actual delivery rate, without
            // assuming a missing packet was lost or fabricating packet counts.
            // 40–49 packets/s settle around 0.60–0.735x. A high queue can catch up.
            float desired = draining ? 1.0f : fminf(1.08f, fmaxf(0.55f, 0.6f + ((float)available - 640) / 2400));
            s->rate += fminf(0.04f, fmaxf(-0.04f, desired - s->rate));
            if (!s->haveTail) s->rate = desired;
            atomic_store_explicit(&queue->stretchRatePermille, (unsigned)(s->rate * 1000), memory_order_relaxed);
            float step = AKStretchHop * s->rate + s->fraction;
            s->advance = (size_t)step;
            s->fraction = step - s->advance;
            size_t best = 0;
            if (s->haveTail) {
                float bestScore = -2;
                for (size_t shift = 0; shift <= AKStretchSearch; shift++) {
                    float dot = 0, a = 0, b = 0;
                    for (size_t i = 0; i < AKStretchHop; i += 4) {
                        float x = s->tail[i];
                        float y = queue->samples[(read + shift + i) % AKPCMCapacity];
                        dot += x * y; a += x * x; b += y * y;
                    }
                    float score = dot / sqrtf(fmaxf(a * b, 1e-12f)) - shift * 0.00001f;
                    if (score > bestScore) { bestScore = score; best = shift; }
                }
            }
            for (size_t i = 0; i < AKStretchHop; i++) {
                float value = queue->samples[(read + best + i) % AKPCMCapacity];
                float mix = (float)i / AKStretchHop;
                if (s->haveTail) value = s->tail[i] * (1 - mix) + value * mix;
                s->tail[i] = queue->samples[(read + best + AKStretchHop + i) % AKPCMCapacity];
                float rising = fminf(1, queue->envelope + 1.0f / AKPCMFade);
                // Fade before the next hop would need unavailable lookahead.
                float target = available < 2 * AKStretchHop + AKStretchSearch + s->advance
                    ? fminf(1, (float)(AKStretchHop - i - 1) / AKPCMFade) : 1;
                queue->envelope = fminf(rising, target);
                s->output[i] = value * queue->envelope;
            }
            s->haveTail = true;
            s->tailOffset = 0;
            s->length = AKStretchHop;
        }
        size_t n = s->length - s->offset;
        if (n > count - produced) n = count - produced;
        memcpy(output + produced, s->output + s->offset, n * sizeof(float));
        produced += n;
        s->offset += n;
        // Keep input alive until this synthesized hop has actually been output.
        if (s->offset == s->length)
            atomic_store_explicit(&queue->read, read + s->advance, memory_order_release);
    }
    atomic_fetch_add_explicit(&queue->stretchOutputSamples, produced, memory_order_relaxed);
    return produced;
}

static size_t AKPCMQueueRender(AKPCMQueue *queue, float *output, size_t count) {
    return queue->stretchEnabled ? AKPCMQueueRenderStretch(queue, output, count)
                                 : AKPCMQueueRenderPlain(queue, output, count);
}

#endif
