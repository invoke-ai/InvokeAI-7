"""One module per model architecture, each making exactly one `register()` call.

These are the only modules allowed to know about architecture-specific packages. Nothing imports
them for their names -- they are imported for their side effect, from the explicit list in
`invokeai/backend/architectures/__init__.py`. The list is explicit rather than a glob so that a
missing definition is distinguishable from a base that does not exist.

A definition module may import only `architectures.facet`, `architectures.facets.*`,
`architectures.registry` and `model_manager.taxonomy`. In particular it must *not* import
`invokeai.backend.architectures` itself: that package imports these modules, so reaching back into
it would be a circular import onto a partially initialised module.
`tests/backend/architectures/test_layering.py` enforces the allowlist.

The file name is the base's enum value with dashes replaced by underscores -- see
`registry.defs_module_path()`.
"""
