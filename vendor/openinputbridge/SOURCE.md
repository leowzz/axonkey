# OpenInputBridge package

Upstream: https://github.com/Applet-LLC/OpenInputBridge

Reviewed release: `1.00` (2026-08-20)

Reviewed source commit: `a661848ddf4deadc07e6c6df9d374c20df5f4c01`

The OpenInputBridge source is MIT licensed. Its production WHQL package is a
separately licensed paid artifact and is not present in this repository.
Axonkey Windows release builds deliberately fail until redistribution rights
have been confirmed and the approved package is placed here with this layout:

```text
vendor/openinputbridge/
  OpenInputBridgeSetup.exe
  oib_kbd/
    oib_kbd.inf
    oib_kbd.cat
    oib_kbd.sys
  oib_mou/
    oib_mou.inf
    oib_mou.cat
    oib_mou.sys
```

Keep any license/readme files supplied with the purchased package in this
directory as well. Do not substitute a self-built test-signed package in a
production release: it requires Windows test-signing mode and disabling normal
Secure Boot protections.

Before accepting a new package, record its version, SHA-256 hashes, signing
subjects, redistribution terms, and RC003 reconnect acceptance results here.
