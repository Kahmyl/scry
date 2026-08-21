# Assurance Qualification Admission

Not every check deserves to become an Assurance verification.

## Required verification admission

A proposed required verification must answer all of the following.

### 1. Claim

What exact factual invariant or outcome does the verification establish?

The claim must be understandable independently of the test implementation.

### 2. Failure sensitivity

Would the verification fail if the defect or violated invariant were
deliberately reintroduced?

If not demonstrated or strongly explainable, the verification is not suitable
as a required gate.

### 3. Oracle

What decides whether the claim holds?

Where practical, the subsystem under test must not be its own sole oracle.

### 4. Evidence

What positive evidence establishes PASS?

Absence of error is insufficient by itself.

### 5. Scope

Does the verification establish a product/capability invariant rather than an
incidental implementation detail?

### 6. Gate justification

Why should failure of this verification block qualification?

A useful measurement is not automatically a gate.

### 7. Generality

If the verification came from a live application failure, what general
browser/system phenomenon does it represent?

### 8. Cost

Is the confidence gained worth the runtime and maintenance cost?

## Observational checks

Useful telemetry and diagnostics that do not establish required behavior should
remain observational.

They must not silently become gates.

## Corpus admission

A regression or capability case may enter the durable corpus when:

1. the phenomenon is understood;
2. a minimal or controlled reproduction exists;
3. the invariant is explicit;
4. the oracle is credible;
5. the positive condition is demonstrated;
6. the verifier is capable of detecting the broken condition.

Application-specific provenance may be retained separately.
