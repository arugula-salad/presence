// S45 spike: what LiveKit Cloud's Analytics API says about the spike's
// sessions (rooms, participant minutes). Needs a token with roomList.
//   ./with-livekit.sh node usage.mjs [project-id]
import { AccessToken } from "livekit-server-sdk";
const project = process.argv[2] ?? "p_393ygiaktwh";
const t = new AccessToken(process.env.LIVEKIT_API_KEY, process.env.LIVEKIT_API_SECRET, { ttl: 300 });
t.addGrant({ roomList: true });
const jwt = await t.toJwt();
const r = await fetch(`https://cloud-api.livekit.io/api/project/${project}/sessions?limit=100`, { headers: { authorization: `Bearer ${jwt}` } });
const body = await r.text();
console.log(r.status);
try {
  const j = JSON.parse(body);
  const s = (j.sessions ?? []).filter((x) => /^(s45:|demo:s45-)/.test(x.roomName));
  console.log(JSON.stringify(s.map((x) => ({ room: x.roomName, created: x.createdAt, ended: x.endedAt, participants: x.numParticipants, bandwidth: x.bandwidthIn, ...x })).slice(0, 3), null, 1));
  console.log(`spike sessions: ${s.length}; keys: ${Object.keys(j).join(",")}`);
} catch {
  console.log(body.slice(0, 300));
}
