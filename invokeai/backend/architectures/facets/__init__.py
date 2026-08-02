"""One module per concern, each defining a `Facet` subclass and the narrow accessors that read it.

Accessors live here rather than in `registry`, because `registry` must not import any concrete
facet -- that would close the loop `registry -> facets -> registry`. A facet module importing the
registry is a plain directed edge.

Every module in this package must be imported from `invokeai/backend/architectures/__init__.py`,
otherwise a facet that declares `REQUIRED = True` would be invisible to `registry.validate()`.
"""
