# Vendored deepmerge security patch

This is the CommonJS source of `deepmerge` 4.3.1 plus upstream commit
`d0256cde79edba0c8e10a888ac439124318b14ca`, which rejects `__proto__` keys in
both merge loops. It is versioned locally as `4.3.2-security.0` until upstream
publishes a release containing the fix for GHSA-gcqx-w48m-w2h4.

The package is used only through Jest's development dependency chain. Keep the
MIT license when updating or removing this vendored copy.
