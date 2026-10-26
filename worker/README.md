# Catalogue worker (graphs.univerlab.org)

Serves the validated documents under `registry/` and the schemas under
`schema/`.

The worker imports the schemas from `../schema/` — it never copies them,
so the contract the worker enforces is always the one in this repo.
