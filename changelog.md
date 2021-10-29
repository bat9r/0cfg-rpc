# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [unreleased]

- Increase the reconnecting websocket connection timeout.
- Added support of log output in JSON format
- The RpcServer now pings websocket clients every second.

## [0.0.9]

### Improved

- Updates the @0cfg/utils-common dependency

### Added

- Support for node versions higher than 14.4.0 

## [0.0.8]

### Improved

- Updates dependencies

## [0.0.7]

### Fixed

- Removed sourcemaps from the final build artifact
- Type incompatibility of the node implementation of ReconnectingWebSocket with ws@~7.4.0

## [0.0.5]

### Fixed

- The RpcServer now handles complete messages to server streams.

## [0.0.2]

### Added 

- Reconnecting Websockets now keep event listeners added even after reconnects.

## [0.0.1] - 2021-02-21

- Initial release

[unreleased]: https://github.com/0cfg/0cfg-rpc/compare/v0.0.9..HEAD
[0.0.9]: https://github.com/0cfg/0cfg-rpc/releases/tag/v0.0.9
[0.0.8]: https://github.com/0cfg/0cfg-rpc/releases/tag/v0.0.8
[0.0.7]: https://github.com/0cfg/0cfg-rpc/releases/tag/v0.0.7
[0.0.5]: https://github.com/0cfg/0cfg-rpc/releases/tag/v0.0.5
[0.0.2]: https://github.com/0cfg/0cfg-rpc/releases/tag/v0.0.2
[0.0.1]: https://github.com/0cfg/0cfg-rpc/releases/tag/v0.0.1
