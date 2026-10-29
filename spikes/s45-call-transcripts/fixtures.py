"""Fetches LibriSpeech test-clean (public domain, openslr.org/12) into its
own directory and cuts the spike's fixtures from it: a few utterances per
fake speaker, as 48 kHz mono 16-bit WAVs, and their reference transcripts.
The audio stays out of git (fixtures/ is ignored).

    python3 -I fixtures.py <download-dir> [fixtures-dir]
"""
import json, os, subprocess, sys, tarfile, urllib.request

URL = "https://www.openslr.org/resources/12/test-clean.tar.gz"
# One LibriSpeech speaker per fake person: two women, one man, and a
# fourth (a man) for the late joiner.
SPEAKERS = {"Ada": "121", "Bo": "1089", "Cy": "2961", "Di": "61"}
PER_SPEAKER_S = 60.0  # about a minute of speech each

dl = os.path.abspath(sys.argv[1])
out = os.path.abspath(sys.argv[2] if len(sys.argv) > 2 else os.path.join(os.path.dirname(__file__), "fixtures"))
os.makedirs(dl, exist_ok=True)
os.makedirs(out, exist_ok=True)
tgz = os.path.join(dl, "test-clean.tar.gz")
if not os.path.exists(tgz):
    urllib.request.urlretrieve(URL, tgz)
root = os.path.join(dl, "LibriSpeech", "test-clean")
if not os.path.isdir(root):
    with tarfile.open(tgz) as t:
        t.extractall(dl, filter="data")

def dur(path):
    r = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", path], capture_output=True, text=True, check=True)
    return float(r.stdout.strip())

refs = {}
for name, spk in SPEAKERS.items():
    picked, total = [], 0.0
    for chap in sorted(os.listdir(os.path.join(root, spk))):
        d = os.path.join(root, spk, chap)
        lines = open(os.path.join(d, f"{spk}-{chap}.trans.txt")).read().splitlines()
        for line in lines:
            uid, text = line.split(" ", 1)
            f = os.path.join(d, uid + ".flac")
            s = dur(f)
            if not 3.5 <= s <= 12.0:
                continue
            wav = os.path.join(out, uid + ".wav")
            subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", f, "-ar", "48000", "-ac", "1", "-sample_fmt", "s16", wav], check=True)
            picked.append({"id": uid, "text": text, "seconds": round(s, 2), "wav": os.path.basename(wav)})
            total += s
            if total >= PER_SPEAKER_S:
                break
        if total >= PER_SPEAKER_S:
            break
    refs[name] = {"librispeech_speaker": spk, "utterances": picked}
    print(f"{name}: speaker {spk}, {len(picked)} utterances, {total:.1f} s")
json.dump(refs, open(os.path.join(out, "refs.json"), "w"), indent=1)
