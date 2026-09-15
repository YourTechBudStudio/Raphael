Fixtures for `module-graph.ts`.

`root.js` reaches a forbidden dependency two hops away, through a relative import made from a nested
directory. A walker that resolves relative specifiers against the test file rather than against the
importing module cannot see it — which is exactly the defect these files exist to catch. Nothing here
is imported by the package; the files are read as text by the graph walker.
