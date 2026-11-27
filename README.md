# lenox-local

Cloud-free, real-time monitoring for a Lenox hybrid inverter (Deye/Sunsynk register map) via its stock Eybond Wi-Fi dongle.

The dongle normally only dials out to the vendor cloud, which is about 5 minutes behind. This app sends it `set>server=<this-machine>:8899;` on UDP 58899, so it connects here instead. The app then reads the inverter over Modbus every ~2 s, stores the readings in SQLite, and serves a dashboard.

```bash
npm install
DONGLE_IP=192.168.0.101 npm start   # dashboard + API on http://<this-machine>:8080
DONGLE_IP=192.168.0.101 npm run live # console only
npm test
```

- **One collector at a time.** Only one program can hold the dongle.
- **Firewall.** Allow Node through the firewall for incoming TCP 8899.
- **Phone app.** While this app runs, the SmartESS app stops getting fresh data.

See [PLAN.md](PLAN.md) for the investigation, protocol notes and milestones. Raw probe captures are in `probe/captures/`.
