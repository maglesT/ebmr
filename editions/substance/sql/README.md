# Migrations of the API edition (`substance` namespace)

The API edition's own SQL (`docs/build-plan/api/plan.md`, `platform-fit.md`). The files run after the `tablets`
namespace in the product `ebmr`'s one database. The lead reserved the numbers 5000 to 5999 for them. A rule here fires
only on records of the `substance` edition and never changes how tablets or injectables behave. The edition list
itself is shared (kernel 1403 `kernel.editions()`) and is not changed here.

The folder is empty of migrations until the first API rule (C2, the blend guard) needs one. An empty namespace changes
no installation's schema release.
