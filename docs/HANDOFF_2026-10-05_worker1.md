# Handoff — 2026-10-05: add worker1 to the fleet

For whoever is at Laptop41 and at the new laptop. The owner has a new worker
laptop called **worker1**. It lends capacity to the coordinator. It does not
host Alpha and does not stand in for the host. This file lists what to run, in
order. Nothing in it has been run yet: a cloud session cannot reach either
machine.

worker1 is the **workhorse** in `FLEET.md`'s terms. It takes general work and
lends most of the machine.

## 1. On Laptop41 (the host): give worker1 its own key

```powershell
cd C:\services\alpha-tunnel
git checkout main; git pull --ff-only
tailscale ip -4                                   # the host's tailnet address: 100.x.y.z
node src/admin/run.js whoami                      # note your userId
node src/admin/run.js issue-key --user <userId> --scopes agent --name worker1
```

Give worker1 a key of its own, never a copy of another machine's. Revocation
is per key (`HOST_SETUP.md`, "A second laptop"). Move the key to worker1 by
hand. Never put it in a repo, a doc or a chat.

The coordinator must also listen on the tailnet address, not only on loopback.
If `.env` has `ALPHA_HOST_BIND=127.0.0.1` alone, make it
`ALPHA_HOST_BIND=127.0.0.1,100.x.y.z` and restart the coordinator
(`HOST_SETUP.md` §8). That restart also starts the queue journal from #72,
which has been waiting on a restart since 2026-10-04.

## 2. On worker1

You need Node 20 or later (`package.json` engines), git, and Tailscale signed in to the same tailnet
as Laptop41.

```powershell
git clone --branch main https://github.com/vyos88/Personal-AI-1.2 C:\services\alpha-tunnel
cd C:\services\alpha-tunnel
# The key is prompted for when --key is left out, so it stays out of shell history.
node scripts/setup-agent.mjs --host http://<100.x.y.z>:8787 --name worker1 --max-load 0.9 --concurrency 4 --memstore
```

Clone with `--branch main`. The repo's GitHub default branch is still an old
feature branch (`STATUS.md`).

`setup-agent.mjs` checks the host and the key, writes `.env.agent`, and
attaches once to prove the loop. For the workhorse share of RAM in
`FLEET.md`, add this to `.env.agent` afterwards:

```ini
ALPHA_AGENT_MEMORY_RESERVE_PERCENT=10
```

Then keep it attached across reboots and on the current release. Run this
**without** `-AlphaRoot`, which installs the agent keeper only:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\install-always-on.ps1
```

Run one agent per machine. Start nothing beside the keeper (`FLEET.md`).

## 3. Prove it, from Laptop41

```powershell
node src/admin/run.js agents                       # a row named worker1
node src/admin/run.js task --type sysinfo --agent worker1
```

Done when the `sysinfo` task comes back from worker1.

## What the cloud can and cannot see

worker1 publishes no `status/<name>` branch, so cloud sessions learn about it
only through Laptop41's doctor report. Today that report's agents section
reads "Not signed in". It lists worker1 only after the admin key is stored
for the doctor's user on Laptop41 (doctor recommendation 6, done by hand
there):

```powershell
[Environment]::SetEnvironmentVariable('ALPHA_ADMIN_TOKEN', (Read-Host 'key'), 'User')
```
