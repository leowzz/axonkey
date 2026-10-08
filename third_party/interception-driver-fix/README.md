## Interception Driver Fix

This application fixes longstanding device reconnection issues for the Interception Driver,
specifically where devices become unresponsive/frozen after being reconnected (hot-plugging) or after waking from sleep.

- [Issue: Connecting new devices stops device from working](https://github.com/oblitum/Interception/issues/25)
- [Issue: Interception causes keyboard to become unresponsive if it is unplugged](https://github.com/oblitum/Interception/issues/93)

Additionally, it includes an optional security feature to lock down the driver, ensuring only applications with Administrator privileges have access to it.

This fix should be installed alongside the [Interception Driver](https://github.com/oblitum/Interception). The driver is not included with the fix.

### Technical details

This fix runs entirely in usermode, and does not require recompiling or altering any original driver files. It operates as a **oneshot service**, launching during Windows startup to acquire the necessary permissions, applies the fix, and then immediately exits.
This approach ensures the driver is patched automatically on every boot with zero background resource usage.

## Installation

You can get the latest installer from the [releases page](https://github.com/hygorostrowskij/interception-driver-fix/releases/latest).

## Configuration

This application can be customized through the `interception-driver-fix.ini` file, which by default is located at `C:/ProgramData/Interception Driver Fix/`.

``` ini
[default]
lockdown=yes  ; Restrict access of the Interception driver only to applications running with Administrator privileges.
```

Note: If you change the configuration file, you may need to restart the service or your computer for changes to take effect.

## Credits

This project makes use of the following open-source libraries:

- [Boost Algorithm](https://github.com/boostorg/algorithm) - General purpose algorithms.
- [CLI11](https://github.com/CLIUtils/CLI11) - Command line parser.
- [fmt](https://github.com/fmtlib/fmt) - Formatting library.
- [Material Symbols / Material Icons](https://github.com/google/material-design-icons) - Iconography.
- [phnt](https://github.com/winsiderss/phnt) - Native API headers.
- [spdlog](https://github.com/gabime/spdlog) - Logging.

A special thanks to @oblitum for creating the incredible Interception Driver.


## License

This project is distributed under a BSD 3-Clause
[license](https://github.com/hygorostrowskij/interception-driver-fix/blob/master/LICENSE).
