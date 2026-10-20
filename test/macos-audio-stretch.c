#include <assert.h>
#include <math.h>
#include <stdio.h>
#include "../src-tauri/native/macos_pcm_queue.h"

typedef struct { size_t filled, total, highWater, underruns; double hz, rate; } Result;
static Result Simulate(double packetsPerSecond, bool enabled, bool recovery) {
    AKPCMQueue q; AKPCMQueueInit(&q); q.stretchEnabled = enabled;
    int16_t input[240]; float output[80];
    double next = 0; size_t source = 0, crossings = 0, measured = 0;
    float previous = 0; Result result = {0};
    // 8 seconds, 5 ms output callbacks, deterministic +/- 5 ms packet jitter.
    for (size_t clock = 0; clock < 8 * 16000; clock += 80) {
        double pps = recovery && clock >= 4 * 16000 ? 16000.0 / 240 : packetsPerSecond;
        while (clock >= next) {
            for (int i = 0; i < 240; i++) input[i] = (int16_t)(12000 * sin(2 * 3.141592653589793 * 220 * (source++) / 16000));
            size_t clipped = 0;
            assert(AKPCMQueuePush(&q, input, 240, 1, &clipped));
            next += 16000 / pps + ((source / 240) % 2 ? 80 : -80);
        }
        size_t n = AKPCMQueueRender(&q, output, 80);
        if (clock >= 16000) { result.filled += n; result.total += 80; }
        for (int i = 0; i < 80; i++) assert(isfinite(output[i]) && fabsf(output[i]) <= 1);
        if (clock >= 2 * 16000 && clock < 4 * 16000) {
            for (int i = 0; i < 80; i++) { crossings += previous <= 0 && output[i] > 0; previous = output[i]; }
            measured += 80;
        }
        size_t queued = AKPCMQueueCount(&q);
        if (queued > result.highWater) result.highWater = queued;
    }
    result.hz = (double)crossings * 16000 / measured;
    result.rate = atomic_load(&q.stretchRatePermille) / 1000.0;
    result.underruns = atomic_load(&q.underruns);
    atomic_store(&q.draining, true);
    // All accepted source samples must drain once, including partial hops.
    for (int i = 0; i < 1000 && AKPCMQueueCount(&q); i++) AKPCMQueueRender(&q, output, 80);
    assert(AKPCMQueueCount(&q) == 0 && atomic_load(&q.read) == source);
    for (int pass = 0; pass < 10; pass++) {
        assert(AKPCMQueueRender(&q, output, 80) == 0);
        for (int i = 0; i < 80; i++) assert(output[i] == 0);
    }
    // A new short silent session must never replay previous voice overlap.
    atomic_store(&q.draining, false);
    for (int i = 0; i < 240; i++) input[i] = 0;
    size_t clipped = 0; assert(AKPCMQueuePush(&q, input, 240, 1, &clipped));
    assert(AKPCMQueueRender(&q, output, 80) == 0);
    atomic_store(&q.draining, true);
    while (AKPCMQueueCount(&q)) {
        AKPCMQueueRender(&q, output, 80);
        for (int i = 0; i < 80; i++) assert(output[i] == 0);
    }
    printf("pps=%.1f stretch=%d recovery=%d coverage=%.3f pitch=%.1f rate=%.3f underruns=%zu max_queue=%zu\n",
        packetsPerSecond, enabled, recovery, (double)result.filled/result.total, result.hz,
        result.rate, result.underruns, result.highWater);
    return result;
}
int main(void) {
    Result plain = Simulate(45, false, false);
    assert((double)plain.filled/plain.total < .75);
    for (double pps = 40; pps <= 49; pps += 4.5) {
        Result stretched = Simulate(pps, true, false);
        assert((double)stretched.filled/stretched.total > .98);
        assert(stretched.hz > 209 && stretched.hz < 231);
        assert(stretched.highWater < 2400);
        assert(stretched.underruns < 3);
    }
    Result recovered = Simulate(45, true, true);
    assert(recovered.rate > .95 && recovered.rate <= 1.08);
    Result full = Simulate(16000.0/240, true, false);
    assert((double)full.filled/full.total > .99 && full.highWater < 2400);
    // An outage must become silence; no unbounded generation from cached audio.
    AKPCMQueue q; AKPCMQueueInit(&q); q.stretchEnabled = true;
    int16_t input[960]; for (int i=0;i<960;i++) input[i]=1000;
    size_t clipped=0; assert(AKPCMQueuePush(&q,input,960,1,&clipped));
    float output[128]; size_t rendered=0;
    for(int i=0;i<100;i++) rendered+=AKPCMQueueRender(&q,output,128);
    assert(rendered < 2000 && atomic_load(&q.underruns)==1);
    for(int i=0;i<128;i++) assert(output[i]==0);
    puts("Adaptive stretch checks passed");
}
