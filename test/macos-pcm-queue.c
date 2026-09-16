#include <assert.h>
#include <math.h>
#include <pthread.h>
#include <sched.h>
#include "../src-tauri/native/macos_pcm_queue.h"

enum { StressSamples = 320000 };
static void *Produce(void *context) {
    AKPCMQueue *queue = context;
    for (size_t offset = 0; offset < StressSamples; offset += 64) {
        int16_t samples[64];
        for (size_t i = 0; i < 64; i++) samples[i] = (int)((offset + i) % 1000) - 500;
        size_t clipped = 0;
        while (!AKPCMQueuePush(queue, samples, 64, 1, &clipped)) sched_yield();
    }
    atomic_store(&queue->draining, true);
    return NULL;
}

int main(void) {
    AKPCMQueue queue;
    AKPCMQueueInit(&queue);
    int16_t input[AKPCMCapacity];
    float output[AKPCMCapacity];
    for (size_t i = 0; i < AKPCMCapacity; i++) input[i] = 16384;
    size_t clipped = 0;
    assert(AKPCMQueuePush(&queue, input, 240, 1, &clipped));
    assert(AKPCMQueueRender(&queue, output, 128) == 0);
    assert(AKPCMQueueCount(&queue) == 240);
    assert(AKPCMQueuePush(&queue, input, 240, 1, &clipped));
    assert(AKPCMQueueRender(&queue, output, 128) == 128);
    assert(output[0] < 0.02f && output[64] == 0.5f);
    assert(AKPCMQueuePush(&queue, input, 240, 1, &clipped));
    assert(AKPCMQueueRender(&queue, output, 128) == 128);
    for (int i = 0; i < 128; i++) assert(output[i] == 0.5f);
    assert(AKPCMQueueRender(&queue, output, 512) == 464);
    assert(output[463] == 0 && output[464] == 0 && output[511] == 0);
    for (int i = 1; i < 512; i++) assert(fabsf(output[i] - output[i - 1]) <= 0.016f);
    assert(atomic_load(&queue.underruns) == 1);
    assert(AKPCMQueueRender(&queue, output, 512) == 0);
    assert(atomic_load(&queue.underruns) == 1);

    // Recovery buffers again. Releasing the key drains even a sub-threshold tail.
    assert(AKPCMQueuePush(&queue, input, 240, 1, &clipped));
    assert(AKPCMQueueRender(&queue, output, 512) == 0);
    atomic_store(&queue.draining, true);
    assert(AKPCMQueueRender(&queue, output, 512) == 240);
    assert(output[0] < 0.02f && output[239] == 0 && output[240] == 0);
    assert(atomic_load(&queue.underruns) == 1);

    // Exercise wraparound, bounded capacity, and partial reads across boundaries.
    for (int pass = 0; pass < 5; pass++) {
        assert(AKPCMQueuePush(&queue, input, AKPCMCapacity, 1, &clipped));
        assert(!AKPCMQueuePush(&queue, input, 1, 1, &clipped));
        assert(AKPCMQueueRender(&queue, output, 1000) == 1000);
        assert(AKPCMQueueCount(&queue) == AKPCMCapacity - 1000);
        assert(AKPCMQueueRender(&queue, output, AKPCMCapacity) == AKPCMCapacity - 1000);
        assert(output[64] == 0.5f && output[AKPCMCapacity - 1001] == 0);
        assert(AKPCMQueueCount(&queue) == 0);
    }
    assert(clipped == 0);

    // Real producer/consumer threads must preserve order across many wraps.
    AKPCMQueueInit(&queue);
    pthread_t producer;
    assert(pthread_create(&producer, NULL, Produce, &queue) == 0);
    size_t total = 0;
    while (total < StressSamples) {
        size_t consumed = AKPCMQueueRender(&queue, output, 128);
        for (size_t i = AKPCMFade; i + AKPCMFade < consumed; i++) {
            float expected = ((int)((total + i) % 1000) - 500) / 32768.0f;
            assert(output[i] == expected);
        }
        total += consumed;
        if (consumed == 0) sched_yield();
    }
    assert(pthread_join(producer, NULL) == 0);
    assert(AKPCMQueueCount(&queue) == 0);
    return 0;
}
