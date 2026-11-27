# Raspberry Pi deployment plan (milestone 4)

**Goal:** the collector, logging and dashboard run 24/7 on a Raspberry Pi on the home network. Phones and laptops open `http://lenox.local:8080` (or the Pi's IP), and optionally reach it from outside the house. The Mac no longer runs the collector.

## 1. Hardware & power

| Item | Recommendation | Why |
|---|---|---|
| Pi model | **Pi 4 (2 GB+) or Pi 5**. A Zero 2 W works but is slow to `npm ci`. | Node 24 needs **64-bit ARM**. A Pi Zero W, Pi 1 or Pi 2 (armv6/armv7) **will not work** with current Node. |
| Storage | A good A1/A2 microSD (Samsung/SanDisk Endurance), **or a USB SSD** (best) | The app writes every 2 s. See section 5 on SD wear. |
| Network | **Ethernet to the router** if possible, otherwise Wi-Fi | One less wireless hop, and the dongle is already on Wi-Fi |
| Power | Run **the Pi and the Wi-Fi router from the inverter's backup (output) side** | During load-shedding the dongle stays powered by the inverter, but if the router or Pi lose power, logging stops exactly when it's most interesting. A Pi uses about 3–5 W. |

### Chosen: Raspberry Pi 3 Model B (decided 2026-11-27)

**Fit:** it's fine for this app.
- **CPU:** a quad Cortex-A53, which is **64-bit capable**, so the arm64 OS and Node 24 work.
- **Memory:** 1 GB RAM is plenty. The app uses ~60–80 MB.
- **Network:** 100 Mb Ethernet and 2.4 GHz Wi-Fi.

Pi 3-specific points:
- **Use the Lite (no desktop) 64-bit image.** It leaves RAM free and boots fast.
- **Use a proper 5 V / 2.5 A supply.** Old phone chargers cause undervoltage (watch for `vcgencmd get_throttled` ≠ `0x0`), and undervoltage is the #1 cause of SD card corruption on Pi 3s.
- **USB/SSD boot needs a one-time step.** Unlike the 3B+, the plain 3B needs an OTP bit set first (`program_usb_boot_mode=1` in `config.txt`, boot once, then remove it). Simpler: boot from the SD card and keep **only the database on a USB stick**, or just rely on the batched writes plus backups in section 5.
- **`npm ci` takes a minute or two.** There are no native builds, so nothing compiles.
- **Prefer Ethernet.** The Pi 3's Wi-Fi shares the 2.4 GHz band with the dongle (channel 2) and is weaker than newer models.

## 2. OS & base setup

1. **Flash the SD card.** Use **Raspberry Pi OS Lite (64-bit, Bookworm or newer)** with Raspberry Pi Imager. In Imager's settings, set:
   - hostname `lenox`
   - your user and an SSH key (no password login)
   - the Wi-Fi details, if not using Ethernet
   - timezone **Asia/Karachi**
2. **Update packages:** `sudo apt update && sudo apt full-upgrade`.
3. **Check the clock.** NTP is on by default (`systemd-timesyncd`); confirm with `timedatectl`. Daily kWh totals are keyed by **local date**, so the Pi's clock and timezone matter.
4. **Install Node 24 (arm64)** from NodeSource's apt repo, so updates come with `apt` and systemd finds it at `/usr/bin/node`:
   ```bash
   curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
   sudo apt install -y nodejs git
   ```
   We need Node ≥ 22.18 or 24 for built-in TypeScript type-stripping and `node:sqlite`. The project has **no native modules**, so nothing needs compiling on the Pi.

## 3. Network & addresses

**DHCP reservations in the Tenda router.** Do this for both, because the dongle is told the Pi's IP and the app is told the dongle's:

| Device | MAC | Reserve |
|---|---|---|
| Eybond dongle | (from the router's client list) | `192.168.0.101` (current) |
| Raspberry Pi | (eth0 or wlan0) | e.g. `192.168.0.50` |

**Ports on the Pi:**
- **TCP 8899:** the dongle dials in here.
- **TCP 8080:** dashboard and API, on the LAN only.
- **UDP:** outgoing to the dongle on 58899.

No inbound ports are opened on the router.

**Only one collector at a time.** Stop the Mac copy before starting the Pi. Otherwise the two keep stealing the dongle from each other.

## 4. Install & run as a service

**Layout**
```
/opt/lenox-local          # git checkout (owned by user "lenox")
/var/lib/lenox-local/     # SQLite DB (DB_PATH)
/etc/lenox-local.env      # config
```

**Get the code** (the repo is private). Pick one:
- **(a) Deploy key, recommended:** create a read-only SSH key on the Pi and add it under the repo's *Settings → Deploy keys*. Then `git clone git@github.com:frzkhan/lenox-local.git /opt/lenox-local`.
- **(b) Copy from the Mac:** `rsync` from the Mac, with no GitHub access on the Pi.

```bash
sudo useradd --system --home /opt/lenox-local --shell /usr/sbin/nologin lenox
sudo mkdir -p /var/lib/lenox-local && sudo chown lenox: /var/lib/lenox-local
cd /opt/lenox-local && sudo -u lenox npm ci --omit=dev
```

**`/etc/lenox-local.env`**
```
DONGLE_IP=192.168.0.101
HOST_IP=192.168.0.50          # the Pi's reserved IP (what the dongle is told)
WEB_PORT=8080
DB_PATH=/var/lib/lenox-local/lenox.db
POLL_MS=2000
```

**`/etc/systemd/system/lenox-local.service`** (this file will live in the repo as `deploy/lenox-local.service`)
```ini
[Unit]
Description=Lenox inverter local monitor
Wants=network-online.target
After=network-online.target time-sync.target

[Service]
User=lenox
WorkingDirectory=/opt/lenox-local
EnvironmentFile=/etc/lenox-local.env
ExecStart=/usr/bin/node src/main.ts
Restart=always
RestartSec=5
# hardening
NoNewPrivileges=true
ProtectSystem=strict
ReadWritePaths=/var/lib/lenox-local
ProtectHome=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
```
```bash
sudo systemctl daemon-reload && sudo systemctl enable --now lenox-local
journalctl -u lenox-local -f     # logs
```

**Updates:** a `deploy/update.sh` script runs `git pull && npm ci --omit=dev && systemctl restart lenox-local`.

**Optional, port 80:** run Caddy as a reverse proxy, so the address is just `http://lenox.local`. Avahi/mDNS is on by default in Pi OS, so `lenox.local` resolves on most phones and laptops.

## 5. Code changes before deploying

| Change | Why |
|---|---|
| **Batch DB writes.** Buffer snapshots and write one transaction every ~30 s, keeping `/api/live` and the WebSocket real-time. | Cuts ~43k small commits a day to ~2.9k, which is much kinder to an SD card |
| **Periodic WAL checkpoint and nightly backup.** `VACUUM INTO /var/lib/lenox-local/backup-YYYY-MM-DD.db`, keeping 7, optionally also copied to USB or the Mac | SD cards die; a lost history hurts |
| **Restore the last snapshot from the DB on start** | After a reboot the dashboard shows the last known values (dimmed) instead of blanks |
| **`HOST_IP` safety check.** On start, log the IP that will be announced, and warn if it isn't on the dongle's subnet | `config.ts` picks the first non-internal IPv4; on a Pi with both eth0 and wlan0 that might be the wrong one |
| **`/healthz` endpoint** returning 200/503 | For systemd, uptime checks and alerts |
| **Inverter-silent alert** (ties into milestone 5) | Today's stall needed a physical dongle replug. If the inverter is silent for more than 10 min, push a notification (ntfy.sh or Telegram) saying "replug the dongle". |
| Ship `deploy/` with the service file, env example and `update.sh` | Repeatable installs |

## 6. Remote access (outside the house), optional

**Recommended: Tailscale on the Pi** (free for personal use).
- Your phone, with Tailscale installed, opens `http://lenox:8080` from anywhere.
- No router port-forwarding and no public exposure.
- The app has no login and the inverter protocol has no security, so **never** port-forward 8080 or 8899 to the internet.

**Alternative:** Cloudflare Tunnel with Cloudflare Access (email login) if you want a normal URL without an app. It's more setup.

## 7. Migration from the Mac

1. Stop the Mac collector with Ctrl-C (or stop `npm start`).
2. **Optional:** copy the history so far: `scp data/lenox.db pi:/var/lib/lenox-local/` (stop the service first).
3. Start the Pi service. The dongle redirect follows the newest `set>server=…`, so the Pi takes over within ~10 s.
4. Check:
   - `curl http://lenox.local:8080/api/status` shows `dongleConnected:true, inverterResponding:true`.
   - `journalctl` shows no read failures.
   - The dashboard loads on your phone.
5. Leave it 24 h. Confirm the `daily` row rolls over at midnight and the `minutes` table keeps growing.

## 8. Open questions / decisions for you

1. ~~Which Pi model?~~ **Pi 3 Model B** (see section 1).
2. **Ethernet or Wi-Fi** for the Pi?
3. **Are the router and Pi on the inverter's backup output?** If the router is not, local monitoring dies during load-shedding.
4. **Remote access:** Tailscale, Cloudflare, or LAN only?
5. **Alerts:** where should "inverter not answering" and "battery low" notifications go (ntfy app, Telegram, none)?

## 9. Risks

- **Inverter link stall.** It happened once on 2026-11-27 and needed a dongle replug. The 30-minute soak test is the check. If it recurs, options are a slower poll (5 s), smaller reads, or a scheduled dongle-side reset if one exists (`AT+` commands are undocumented, so test carefully).
- **SD card corruption on power loss.** Mitigated by WAL with `synchronous=NORMAL` (the last few seconds may be lost, but the DB doesn't corrupt), the backups, and backup power. Optionally enable the overlay read-only root filesystem with the DB on USB.
- **IP changes.** If the dongle or Pi IP changes, the redirect breaks. The DHCP reservations prevent that, and the announcer also falls back to subnet broadcast.
