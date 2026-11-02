#!/usr/bin/env python3
"""Benchmark a streaming OpenAI-compatible endpoint using LIKECODE_* env vars."""

import argparse
import json
import os
import signal
import statistics
import sys
import time
import urllib.error
import urllib.request


PROMPT = (
    "Write a detailed practical guide to organizing a home office in English. "
    "Use about 500 words of continuous prose. Start the guide immediately, "
    "without an introduction about the task, and keep writing until complete."
)


def timeout_handler(signum, frame):
    raise TimeoutError("Benchmark exceeded the whole-request timeout")


def events(response):
    data = []
    for raw_line in response:
        line = raw_line.decode("utf-8").rstrip("\r\n")
        if not line and data:
            yield "\n".join(data)
            data = []
        elif line.startswith("data:"):
            data.append(line[5:].lstrip(" "))
    if data:
        yield "\n".join(data)


def benchmark(args, endpoint, api_key):
    payload = {"model": args.model, "stream": True}
    if args.service_tier is not None:
        payload["service_tier"] = args.service_tier
    if args.api == "responses":
        payload.update(
            input=[{"role": "user", "content": args.prompt}],
            max_output_tokens=args.max_tokens,
            store=False,
        )
        if args.reasoning != "default":
            payload["reasoning"] = {"effort": args.reasoning}
    else:
        payload.update(
            messages=[{"role": "user", "content": args.prompt}],
            max_completion_tokens=args.max_tokens,
            stream_options={"include_usage": True},
        )
        if args.reasoning != "default":
            payload["reasoning_effort"] = args.reasoning
    request = urllib.request.Request(
        endpoint,
        data=json.dumps(payload).encode("utf-8"),
        headers={
            "Authorization": "Bearer " + api_key,
            "Content-Type": "application/json",
            "Accept": "text/event-stream",
        },
    )
    start = time.perf_counter()
    first_text = last_text = None
    usage = {}
    chunks = 0
    preview = ""
    returned_model = None
    returned_service_tier = None
    finished = False
    finish_reason = None
    with urllib.request.urlopen(request, timeout=args.timeout) as response:
        if "text/event-stream" not in response.headers.get("Content-Type", ""):
            raise RuntimeError("Expected an SSE stream; the server returned another content type")
        for raw_event in events(response):
            now = time.perf_counter()
            if raw_event == "[DONE]":
                finished = True
                break
            event = json.loads(raw_event)
            kind = event.get("type", "")
            if event.get("error") or kind in ("error", "response.failed"):
                raise RuntimeError(json.dumps(event)[:1500])
            text = ""
            if args.api == "responses":
                if kind == "response.output_text.delta":
                    text = event.get("delta", "")
                result = event.get("response") or {}
                returned_model = result.get("model") or returned_model
                returned_service_tier = result.get("service_tier") or returned_service_tier
                usage = result.get("usage") or usage
                if kind in ("response.completed", "response.incomplete"):
                    finished = True
                    finish_reason = result.get("incomplete_details") or result.get("status")
                    break
            else:
                returned_model = event.get("model") or returned_model
                returned_service_tier = event.get("service_tier") or returned_service_tier
                usage = event.get("usage") or usage
                for choice in event.get("choices", []):
                    text += choice.get("delta", {}).get("content") or ""
                    finish_reason = choice.get("finish_reason") or finish_reason
            if text:
                if first_text is None:
                    first_text = now
                    print("First text after %.3fs" % (now - start), file=sys.stderr, flush=True)
                last_text = now
                chunks += 1
                preview = (preview + text)[:160]
    total_seconds = time.perf_counter() - start
    if not finished:
        raise RuntimeError("Stream ended without a completion event; measurement discarded")
    if first_text is None:
        raise RuntimeError("No text was generated; usage=" + json.dumps(usage))
    output_tokens = usage.get("output_tokens", usage.get("completion_tokens"))
    if not isinstance(output_tokens, int) or output_tokens <= 0:
        raise RuntimeError("Server did not return output token usage; cannot measure tokens/s")
    details = usage.get("output_tokens_details") or usage.get("completion_tokens_details") or {}
    reasoning_tokens = details.get("reasoning_tokens")
    text_tokens = output_tokens - reasoning_tokens if isinstance(reasoning_tokens, int) else None
    stream_seconds = last_text - first_text
    # Text arrives in chunks, so this is an estimate of post-first-text throughput.
    decode_rate = (
        text_tokens / stream_seconds
        if text_tokens is not None and stream_seconds > 0 and chunks > 1
        else None
    )
    return {
        "returned_model": returned_model,
        "returned_service_tier": returned_service_tier,
        "ttft_seconds": round(first_text - start, 4),
        "total_seconds": round(total_seconds, 4),
        "text_stream_seconds": round(stream_seconds, 4),
        "output_tokens": output_tokens,
        "reasoning_tokens": reasoning_tokens,
        "text_tokens": text_tokens,
        "decode_text_tokens_per_second_approx": round(decode_rate, 2) if decode_rate is not None else None,
        "end_to_end_output_tokens_per_second": round(output_tokens / total_seconds, 2),
        "text_chunks": chunks,
        "finish_reason": finish_reason,
        "preview": preview,
        "usage": usage,
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--model", default="gpt-6-astra")
    parser.add_argument("--api", choices=("responses", "chat"), default="responses")
    parser.add_argument("--runs", type=int, default=3)
    parser.add_argument("--max-tokens", type=int, default=1024)
    parser.add_argument("--reasoning", default="default", help="Reasoning effort, or 'default' to omit")
    tier = parser.add_mutually_exclusive_group()
    tier.add_argument("--fast", dest="service_tier", action="store_const", const="fast",
                      help="Request Fast mode via service_tier=fast")
    tier.add_argument("--service-tier", choices=("auto", "default", "flex", "priority", "fast", "ultrafast"),
                      help="Explicit service tier; omitted by default")
    parser.add_argument("--timeout", type=float, default=120,
                        help="Timeout in seconds (whole request on Unix; socket on Windows)")
    parser.add_argument("--prompt", default=PROMPT)
    args = parser.parse_args()
    if args.runs < 1 or args.max_tokens < 1 or args.timeout <= 0:
        parser.error("runs, max-tokens, and timeout must be positive")
    base_url = os.environ.get("LIKECODE_BASE_URL", "").rstrip("/")
    api_key = os.environ.get("LIKECODE_API_KEY", "")
    if not base_url or not api_key:
        parser.error("Set LIKECODE_BASE_URL and LIKECODE_API_KEY")
    if not base_url.endswith("/v1"):
        base_url += "/v1"
    endpoint = base_url + ("/responses" if args.api == "responses" else "/chat/completions")
    print(json.dumps({"endpoint": endpoint, "requested_model": args.model,
                      "reasoning": args.reasoning, "max_tokens": args.max_tokens,
                      "requested_service_tier": args.service_tier}), flush=True)
    results = []
    for run in range(1, args.runs + 1):
        print("Running %d/%d..." % (run, args.runs), file=sys.stderr, flush=True)
        try:
            if hasattr(signal, "SIGALRM"):
                signal.signal(signal.SIGALRM, timeout_handler)
                signal.setitimer(signal.ITIMER_REAL, args.timeout)
            result = benchmark(args, endpoint, api_key)
        except (urllib.error.URLError, OSError, ValueError, RuntimeError) as error:
            message = str(error)
            if isinstance(error, urllib.error.HTTPError):
                message += ": " + error.read(4096).decode("utf-8", errors="replace")
            print("Request failed: " + message.replace(api_key, "<redacted>"), file=sys.stderr)
            return 1
        finally:
            if hasattr(signal, "SIGALRM"):
                signal.setitimer(signal.ITIMER_REAL, 0)
        results.append(result)
        print(json.dumps({"run": run, **result}, ensure_ascii=False), flush=True)
    rates = [r["decode_text_tokens_per_second_approx"] for r in results
             if r["decode_text_tokens_per_second_approx"] is not None]
    print(json.dumps({"summary": {
        "successful_runs": len(results),
        "mean_ttft_seconds": round(statistics.mean(r["ttft_seconds"] for r in results), 4),
        "mean_decode_text_tokens_per_second_approx": round(statistics.mean(rates), 2) if rates else None,
        "aggregate_end_to_end_output_tokens_per_second": round(
            sum(r["output_tokens"] for r in results) / sum(r["total_seconds"] for r in results), 2),
    }}), flush=True)
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        print("Benchmark interrupted", file=sys.stderr)
        sys.exit(130)
