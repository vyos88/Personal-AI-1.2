# Handoff: the CrowPanel fix from ~00:30 UTC didn't stick (2026-10-07, ~05:15 UTC)

## What happened

Laptop41's Wi-Fi address moved again — from `192.168.2.151` (fixed earlier
today, confirmed working for several hours with the panel calling in 38-39
times) to **`192.168.1.151`**, a different subnet. The backend's `HOST`
setting still only lists the old address, so the exact same failure mode
from earlier today is back:

> `PROBLEM: the backend listens on no home-network address (this machine
> has 192.168.1.151 on Wi-Fi): the deck panel cannot reach it`
> `PROBLEM: no device on the home network has called the backend in the
> last couple of minutes: the deck panel is not reaching this machine`

This is exactly the failure the doctor's own hardening recommendation #2
warned about: *"A DHCP reservation for this machine stops the address
moving."* That reservation evidently wasn't set after the first fix, so a
second lease change (switching networks, or a router renumbering) broke it
again the same way.

## Not something to merge — a live-host networking fix

Same remedy as before: add `192.168.1.151` to `HOST` in `.env.local`
(keeping `127.0.0.1` and the tailnet address), restart the backend, and —
this time — set a DHCP reservation for this machine so a third recurrence
doesn't happen. Re-provisioning the panel over serial is the fallback if
the address itself turns out to be unstable rather than just unlisted.

## Everything else this pass

No new PRs on either repo. Everything previously flagged (#160 merge
conflict, #136, #99, #153 noise, Alpha #80/#76/#74) is unchanged.
