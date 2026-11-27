# Lenox Inverter: Local Monitoring App (Node.js)

_Updated: 2026-11-27, after the Phase 0 probe_

## 1. Summary

- **Local access works.** The Eybond Wi-Fi dongle (`E60000230574080288`) accepted a redirect to this Mac and forwarded our Modbus reads to the inverter. Replies arrive in ~330 ms, compared with the cloud's ~5-minute interval.
- **The inverter speaks Modbus RTU, not Voltronic PI30.** Its registers fit the **Deye/Sunsynk single-phase hybrid map** (cross-checked in section 4). The Lenox is most likely a Deye-platform rebadge.
- **Next:** build a Node.js collector, an API and a web dashboard around Modbus FC3 block reads.

## 2. Why the apps "can" and you "couldn't"

```
Inverter ──RS485──> Eybond dongle ──outbound TCP──> Eybond cloud <──HTTPS── SmartESS / "SmartValue" app
```

- The dongle is a **TCP client only**. It dials out to the cloud and listens on no TCP port, so connecting to it directly finds nothing.
- The phone app reads the cloud's copy, which is about 5 minutes old.
- The dongle does listen on **UDP 58899** for setup commands. `set>server=<IP>:<PORT>;` makes it dial **our** server instead, and then we act as the cloud.

Projects that use the same method: [SolarPulse](https://github.com/musaoc/SolarPulse), [ha-smartess-local](https://github.com/ubombi/ha-smartess-local), [ha-eybond-local](https://github.com/oleks-p/ha-eybond-local), [phantom-bridge](https://github.com/TechNerdXp/phantom-bridge), [Local-Cloud-Bridge](https://github.com/samuelolteanu/Local-Cloud-Bridge-for-Anenji-Easun-MPP-Solar-Inverters).

## 3. Network facts (this house)

| Item | Value |
|---|---|
| Router | `192.168.0.1` (Tenda / GoAhead) |
| Dongle | **`192.168.0.101`** (DHCP; **add a DHCP reservation**), PN `E60000230574080288`, setup AP SSID is the same |
| This Mac | `192.168.0.102`. The macOS firewall is on, so allow Node for incoming TCP 8899. |
| Redirect | Unicast to the dongle IP failed with `EHOSTUNREACH` (probably macOS local-network privacy). **The subnet broadcast `192.168.0.255:58899` worked.** The dongle replied `rsp>server=1;`. |

## 4. Phase 0 results (read-only; captures in `probe/captures/`)

**Transport: Eybond framing over TCP 8899 (big-endian)**
```
[TID u16][DevCode u16][Len u16 = bytes after first 6][Addr u8][FC u8][payload]
```
- **FC=1 heartbeat:** we send `[yy mm dd hh mm ss][interval u16]`, and the dongle replies with its ASCII PN.
- **FC=4 forward:** the payload is a raw **Modbus RTU** frame (slave 1, CRC16-Modbus), and the reply comes back with the same TID. An empty reply means the inverter did not answer.
- **Devcode** was `0x0000` in the heartbeat. The dongle forwarded with either `0x0993` or `0x0994`.

**What the inverter answered**
- **PI30 (`QPIGS`…) and PI17 (`^P005…`):** no answer.
- **Modbus FC3:** holding registers 0–0x01FF answer. 0x0200 read all zero. **Beyond 0x0210 is untested, and FC4 was tried only once, at address 0.**

**Decoded with the Deye/Sunsynk single-phase hybrid map** (one sample, during grid outage):

| Reg | Meaning | Sample |
|---|---|---|
| 0 | Device type (3 = single-phase hybrid) | 3 |
| 3–7 | Serial (ASCII) | `2503180145` |
| 22–24 | Inverter clock (YY/MM, DD/hh, mm/ss byte pairs) | 26/11 27/08 50:12, which **matches local time** |
| 109/110, 111/112 | PV1 and PV2 voltage/current (×0.1) | 422.9 V 1.9 A; 434.0 V 1.6 A |
| 186/187 | PV1 and PV2 power (W) | 787, 685 |
| 183 / 184 | Battery voltage ×0.01 V / SOC % | 53.34 V, 53 % |
| 190 / 191 | Battery power W / current ×0.01 A (signed, negative = charging) | −893 W, −16.75 A (53.34 × 16.75 = 893 ✓) |
| 178 | Load power W | 450 |
| 150 / 79 | Grid voltage ×0.1 / frequency ×0.01 | 18.6 V, 0 Hz, so the grid was **off** at the time |
| 154 | Inverter output voltage ×0.1 | 230.0 V |
| 90 / 91 | Temperatures, (x − 1000) × 0.1 °C | 37.6, 28.6 |
| 108, 84, 76, 70/71 | Today kWh ×0.1: PV, load, grid buy, battery charge/discharge | 1.1, 5.9, 3.1, 2.8/5.4 |
| 182 | Battery temperature | −79 °C, **wrong**: no sensor, or a different offset |

- **Still to do:** check values against the inverter LCD (grid V, load W, SOC) and against a published Deye map such as [kellerza/sunsynk](https://github.com/kellerza/sunsynk) definitions.
- **Settings:** registers 0x0100–0x01FF look like the settings block (time-of-use, voltages, limits). **Do not write to them** until the map is confirmed.

**Caveats found during the probe**
- **A second collector was running.** SolarPulse (`~/Desktop/projects/github-projects/SolarPulse`, PID 76597) listened on 8899 at the same time and took over the dongle mid-scan. That caused the reconnects. Only one collector can own the dongle. SolarPulse speaks PI30, so **it can't read this inverter**; stop it before running ours.
- **Untested:** whether the redirect expires and falls back to the cloud on its own, and after how long. SolarPulse's "re-announce every 90 s" comes from a different unit. Test it: announce once, then time how long the session lasts. If it never falls back, a dongle power-cycle restores the cloud.

## 5. Architecture

```
            UDP 58899 broadcast (set>server, re-sent only if disconnected / per measured timeout)
   ┌──────────────────────────────────────────────┐
   │                                              ▼
┌──────────────────────────────┐   TCP 8899   ┌─────────────┐  RS485  ┌──────────────┐
│ lenox-local (Node 24, TS)    │ <─────────── │ Eybond      │ ◄─────► │ Lenox (Deye- │
│ ├ collector  net + dgram     │              │ dongle .101 │         │ map) inverter│
│ ├ protocol   eybond + modbus │              └─────────────┘         └──────────────┘
│ ├ registers  map → values    │
│ ├ poller     1 in flight     │
│ ├ store      SQLite (WAL)    │
│ ├ api        Fastify REST+WS │ ◄── browser (phone / PC on LAN)
│ └ web        dashboard SPA   │
└──────────────────────────────┘
```

**Modules**
```
src/collector/announcer.ts   # broadcast set>server; parse rsp>
src/collector/server.ts      # accept dongle, reassemble frames, heartbeat, survive reconnects WITHOUT restarting state
src/protocol/eybond.ts       # header encode/decode, TID → promise
src/protocol/modbus.ts       # FC3 read builder, CRC16, response/exception parse (FC6/FC16 later, behind a flag)
src/registers/deye-1p.ts     # register definitions: addr, scale, signed, unit, group
src/poller.ts                # fast 2 s: 70–191 in 2–3 block reads (max ~60 regs/read); slow 60 s: 0–69, settings
src/store/db.ts              # samples (7 d), 1-min/hour/day rollups; inverter's own daily kWh counters
src/api/*.ts                 # /api/live, /api/history, /api/status, /ws/live
web/                         # power-flow card (PV1/PV2 → battery/grid → load), SOC, charts, daily kWh
test/fixtures/               # frames from probe/captures
```

**Stack:** Node 24 + TypeScript using built-in `net`/`dgram`. Fastify with `@fastify/websocket` and `@fastify/static`. `better-sqlite3`. Vite + Preact with uPlot for the web UI. `mqtt` for Home Assistant (optional).

**Rules**
- One Modbus request in flight at a time. Leave ~100–150 ms gaps between requests.
- Read in big blocks, about 3 FC3 reads per 2-second cycle.
- A reconnect keeps the poller state and simply resumes.
- Run as the only collector on the network.

## 6. Milestones

| # | Deliverable | Status |
|---|---|---|
| 0 | Probe: redirect, protocol, register sample | ✅ done |
| 0b | Confirm the register map against the LCD and a published Deye map; measure redirect persistence; finish the scan to 0x04FF and FC4 | next |
| 1 | Collector, Eybond and Modbus libraries, Deye map, unit tests from fixtures; console prints live values | ✅ done: `DONGLE_IP=192.168.0.101 npm run live`; 11 tests pass; ran ~90 s live at 2 s/update with no drops |
| 2 | SQLite logging, REST/WebSocket API, energy totals (prefer the inverter's own kWh registers) | ✅ done: `DONGLE_IP=192.168.0.101 npm start` serves http://<mac>:8080 (`/api/live`, `/api/status`, `/api/history?range=1h…365d`, `/api/energy/daily?days=N`, `ws /ws/live`); DB at `data/lenox.db` (built-in `node:sqlite`); 17 tests pass; verified live |
| 3 | Web dashboard (phone-friendly) | 🟡 built (`web/`: power flow, battery, today, details, uPlot history + SOC, daily bars with table), checked at desktop and 375 px width. Blocked on the inverter link: see below. |

**Open issue (2026-11-27 09:24):** after ~25 s of polling in the 5th session, the inverter stopped answering Modbus. The first failed read was a CRC mismatch; every read after that returned an empty FC=4 reply (the dongle forwards, the inverter is silent). It is still silent after 3 quiet minutes and with 1-register reads on any devcode. The app now **backs off** in this state: one tiny read every 20 s, no reconnect loop, `inverterResponding:false` in `/api/status`, and the dashboard dims. The longest clean run so far is ~90 s. **Do a 30–60 min soak before milestone 4.**

Diagnosis (09:38–09:44):
- **The cloud gets no answer either.** `probe/cloud-proxy.mjs` relays dongle ↔ `iot.eybond.com:18899` and logs both directions (capture in `probe/captures/cloud-proxy-*.jsonl`). The real cloud sent bare Modbus reads `01 03 0000 0001` and `01 03 0064 0001`, and the inverter answered neither. After that the cloud only sent `AT+HTBT?` heartbeats. So the dongle-to-inverter link is down for everyone, not just for us. The phone app's "fresh" timestamp is probably driven by the dongle heartbeat.
- **The cloud uses a different framing.** It speaks *transparent* mode on port 18899: AT text commands plus bare Modbus RTU, with no Eybond header. On our port 8899 the dongle answers Eybond-header frames and AT commands, but bare RTU got no reply (tested while the inverter was silent, so that result is inconclusive).
- **Dongle facts from read-only AT queries:** `AT+UART:9600,8,1,NONE`, `AT+CLDSRVHOST1:iot.eybond.com,18899,TCP`, `AT+FWVER:7.63.6.191`, `AT+WFSS:-55` (Wi-Fi RSSI). The cloud also sets the dongle clock with `AT+SYST=`.
- **Next step:** physically reset the link. Unplug the dongle from the inverter, wait 10 s and plug it back in. If it is still silent, check the inverter's comm settings or LCD, or restart the inverter.
| 4 | Always-on deployment on a **Raspberry Pi** (systemd, DHCP reservations, batched writes, backups, health endpoint) | planned: see [docs/raspberry-pi.md](docs/raspberry-pi.md) |
| 5 (opt.) | MQTT / Home Assistant, alerts (grid lost, SOC low), CSV export, optional relay to the Eybond cloud so the phone app keeps working | |
| 6 (opt., careful) | Settings writes (FC16) for the ToU and charge limits: off by default, with confirmation, read-back and rate limits | |

## 7. Risks

- **The phone app goes stale while we hold the dongle.** Mitigation: relay mode in milestone 5.
- **The register map is unconfirmed.** It is very likely Deye-compatible from two arithmetic cross-checks, but there may be per-model differences (battery temperature is already off).
- **Writes are dangerous.** A wrong battery or ToU setting can damage the battery or drop loads. Writes stay last and gated.
- **The protocol has no security.** Keep the app LAN-only, and optionally block the dongle's internet access later.
- **Fallback transport:** if the dongle ever blocks redirects, use RS485-to-USB directly to the inverter's BMS/485 port. The Modbus layer stays the same.
