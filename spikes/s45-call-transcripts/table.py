"""Prints the README's results table from each run's summary.json."""
import json, sys
print("| run | model | gate | WER | ref words | attributed | final after speech end p50/p90 ms | after it reached the agent p50 | first interim after start p50 | caption in others' browsers p50/p90 | STT s | track s | speech s |")
print("|---|---|---|---|---|---|---|---|---|---|---|---|---|")
for r in sys.argv[1:]:
    s = json.load(open(f"runs/{r}/summary.json")); L = s["latency_ms"]; st = s["stt"]; a = s["attribution"]
    g = lambda k, f: L[k].get(f, "-")
    print(f"| {r} | {s['meta']['model']} | {s['meta']['gate']} | {s['wer']*100:.1f}% | {s['ref_words']} | {a['ok']}/{a['ok']+a['bad']} | {g('final_after_speech_end','p50')} / {g('final_after_speech_end','p90')} | {g('final_after_speech_reached_agent','p50')} | {g('first_interim_after_speech_start','p50')} | {g('caption_in_other_browsers_after_speech_end','p50')} / {g('caption_in_other_browsers_after_speech_end','p90')} | {st['stt_s']} | {st['track_s']} | {st['speech_s']} |")
