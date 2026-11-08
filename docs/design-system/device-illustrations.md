# Device illustrations

Source: [Orka/DeviceIllustration in Figma](https://www.figma.com/design/sZvXR3kIyso2CxTHX8shDw/Orka?node-id=1248-800).

The existing Generic, Laptop, All-in-one, Mac mini, Mac Studio, and Mac Pro illustrations are bundled in `apps/mac/public/devices/`. Each is a 128×128 PNG displayed at 48×48 in Settings. Images have explicit dimensions and load lazily.

The five identified families are Laptop (all MacBooks), All-in-one (iMac and iMac Pro), Mac mini, Mac Studio, and Mac Pro (tower, rack, and cylinder). Generic is reserved for unidentified hardware. The six bundled PNGs were checked byte for byte against fresh 128 px exports of the existing Figma variants on November 7, 2026. They render at 48×48; no artwork was substituted.

Native detection first tries the hardware model identifier from `sysctl hw.model` (up to 250 ms), then the hardware `machine_name` / `machine_model` from English `system_profiler` JSON. Both probes share a three-second budget and a 64 KB output limit. Opaque Apple Silicon identifiers are not guessed. Failed or unknown results retry after 30 seconds; positively identified hardware is cached. Known local metadata is also persisted so a later process or lookup failure does not erase it.

Registration sends `hardwareFamily` only when the service advertises `deviceHardware: 1`. API storage preserves a known family when later registrations omit metadata or report Generic. Native list refreshes preserve each remote device's own known metadata. This Mac uses locally detected hardware even when an older service omits the field; remote Macs never borrow the viewing Mac's family. Names, account names, and screen size are not classification inputs. An unknown remote Mac updates when it reports valid metadata, including while Devices stays open.

Only actual registered rows appear in the product. Category-coverage screenshots are explicitly labeled fixtures. Missing artwork remains an asset error; it never silently switches a known device to Generic. `This Mac` uses registered identity, and `Last seen` does not imply Connected/Disconnected badges.

Native fixtures cover family parsing, malformed/missing metadata, timeout/output bounds, retry recovery, and cache preservation. Real local PostgreSQL/HTTP/native tests cover registration and older-service list responses. Browser checks decode all six PNGs and inspect 48 px geometry, accessibility, metadata updates, and loading. Production Cloud capability and physical tests across all five Mac families remain separate, unverified checks.

`apps/mac/public/icons/loading.svg` is the existing eight-spoke indicator from the approved [Button loading state](https://www.figma.com/design/sZvXR3kIyso2CxTHX8shDw/Orka?node-id=1196-214). The shared ActivityIndicator consumes it and respects reduced motion.
