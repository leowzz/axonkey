#ifndef AK_MACOS_PCM_QUEUE_H
#define AK_MACOS_PCM_QUEUE_H

#include <stdbool.h>
#include <stdint.h>
#include <stdatomic.h>
#include <string.h>

// One producer (the Bluetooth queue) and one consumer (Core Audio). Neither
// side waits for the other; the render callback allocates and logs nothing.
enum { AKPCMCapacity = 4096, AKPCMPrebuffer = 480, AKPCMFade = 32 };
typedef struct {
    float samples[AKPCMCapacity];
    atomic_uint_fast64_t written;
    atomic_uint_fast64_t read;
    atomic_uint_fast64_t underruns;
    atomic_bool draining;
    bool primed;
    float envelope;
} AKPCMQueue;

static void AKPCMQueueInit(AKPCMQueue *queue) {
    memset(queue->samples, 0, sizeof(queue->samples));
    atomic_init(&queue->written, 0);
    atomic_init(&queue->read, 0);
    atomic_init(&queue->underruns, 0);
    atomic_init(&queue->draining, false);
    queue->primed = false;
    queue->envelope = 0;
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

static size_t AKPCMQueueRender(AKPCMQueue *queue, float *output, size_t count) {
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

#endif
