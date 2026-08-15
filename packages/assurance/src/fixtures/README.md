# Fixtures

Fixtures create controlled, reproducible states for Assurance.

A strong fixture exposes independent ground truth.

For example, the browser may contain a Submit button while the fixture
independently records:

- whether dispatch actually happened;
- dispatch count;
- submitted payload;
- authoritative resulting state.

That lets Assurance verify behavior without asking the subsystem under test
whether it believes it succeeded.
