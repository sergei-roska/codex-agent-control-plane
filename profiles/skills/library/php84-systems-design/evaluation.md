# Evaluation: PHP 8.4 Systems Design Skill

## 1. Diagnosis of the Draft
The original draft (`php83-systems-design`) functioned well as a technical reference or best-practices checklist for PHP 8.3 in Drupal. It correctly identified key modern PHP features (Enums, strict typing, match expressions, readonly properties) and presented clear code examples. However, from an agent's operational perspective, it lacked triggering conditions, explicit retrieval modes, and persistence rules. It also needed to be upgraded to PHP 8.4 to support the latest features (like property hooks and asymmetric visibility).

### Strengths
- Clear, practical examples of modern PHP patterns applied to Drupal.
- Strong emphasis on shifting away from legacy hook-based procedural code to OOP.
- Good anti-patterns section marking out old Drupal habits that need breaking.

### Gaps
- **Missing PHP 8.4 Features:** It lacked new capabilities like Asymmetric Visibility and Property Hooks which heavily impact class design.
- **Operational Triggers:** Did not clearly instruct an agent *when* to check these rules (e.g., during code review, or before creating a new class).
- **Retrieval Rules:** Failed to define what an agent should search for before making design decisions (e.g., searching for existing Enums or service interfaces).
- **Persistence Rules:** No instructions on what architectural decisions should be remembered in memory.
- **Scope Definition:** The boundaries of where these rules apply were implied rather than explicitly bounded.

### Risks
- An agent might read the skill but fail to apply it systematically because it reads like a wiki page rather than a workflow.
- An agent could unnecessarily apply rules to frontend Twig logic or out-of-scope legacy code, wasting effort.
- Missing persistence instructions means fundamental architectural choices (like why a service is mutable) would be forgotten across sessions.

---

## 2. Preserved Ideas
- The core philosophy of prioritizing architectural patterns (strict types, DI, Enums) over legacy hooks.
- The use of constructor property promotion with `readonly`.
- `match` expression over `switch`.
- Converting arbitrary string states into backed Enums.
- The anti-patterns section, specifically prohibiting `mixed` types and `\Drupal::service()` in OOP code.

---

## 3. Missing Pieces Added
- **PHP 8.4 Upgrades:** Replaced some generic readonly references with Asymmetric Visibility (`public private(set)`) and Property Hooks. Included new array functions like `array_find`.
- **Operational Execution Guide:** Converted the list of features into a step-by-step checklist applied when writing code.
- **Retrieval Modes & Intent:** Defined specific queries (e.g., `enum *`, `*Interface`) the agent must run before creating overlapping structures.
- **Persistence & Write Rules:** Defined explicit MUST PERSIST and MUST NOT PERSIST gates for documenting architectural decisions.
- **Scope Bounding:** Added clear rules on what the skill applies to (Module-level OOP, refactoring) and what it does not (Twig, Javascript).

---

## 4. Rewritten Skill Text
See `SKILL.md`.

---

## 5. Explicit Rules Implemented
- **Retrieval:** Search for existing Enums, interfaces, or attributes before creating duplicates or defaulting to hooks.
- **Persistence:** Document intentional escapes from strict types (e.g., mutability rationale, justified `switch` usage) but do not record routine DI boilerplate.
- **Update Behavior:** If modifying older code, enforce `declare(strict_types=1)` and apply the new standards incrementally.
