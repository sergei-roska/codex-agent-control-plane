---
name: php84-systems-design
description: Architect Drupal services and plugins using modern PHP 8.4 features, strict typing, and dependency injection. Use this skill when initiating any new class creation, performing refactoring, reviewing PRs, or updating legacy procedural code into modern object-oriented structures.
---

# PHP 8.4 Systems Design for Drupal

## Core Philosophy

Implement technical logic using PHP 8.4 standards to ensure maximum safety, clarity, and performance. This skill prioritizes architectural patterns over legacy Drupal hooks and global state.

It shifts the focus from "writing code that works" to "designing systems that are type-safe, intention-revealing, and easily auditable by static analysis."

## Bounded Scope

This skill applies to:
- **Module-level** implementation of custom Drupal services, controllers, and plugins.
- **Refactoring** tasks targeting procedural `.module` code or outdated OOP code.
- **Code reviews** ensuring adherence to modern PHP constraints.
- **Project-wide** technical debt remediation strategies.

It **does not** apply to:
- Frontend Twig templates or Javascript.
- Raw database querying without the core abstraction layer.

---

## Operational Execution Guide

When triggered to apply this skill, immediately evaluate the current task against these rules:

### A. Initialization & Declaration
1. **Always declare strict types:** `declare(strict_types=1);` must be the first statement in every new or refactored PHP file.
2. **Class immutability:** Mark new stateless service classes as `readonly class` (PHP 8.2+, Drupal 10.3+).
3. **Extension constraint:** Mark classes as `final` unless extension is an explicit, documented architectural requirement.

### B. Typing & State Management
1. **Exhaustive typing:** Use full type hints for all parameters, return types, and properties. Avoid `mixed` unless strictly justified and documented.
2. **Property Hooks & Asymmetric Visibility (PHP 8.4):** 
   - Use asymmetric visibility for properties (e.g., `public private(set) string $status;`) instead of writing boilerplate getter methods when exposing read-only data.
   - Use Property Hooks if explicit transformation is needed on access or modification.
3. **Readonly declarations:** Use `readonly` for constructor property promotion on dependencies and DTOs.
4. **Enums for fixed states:** Replace boolean flags, string constants, and arbitrary strings with backed Enums (`string` or `int`).

### C. Control Flow & Logic
1. **Exhaustive matching:** Use `match` instead of `switch` for value-returning conditional logic. Fall-through `switch` behavior is an anti-pattern.
2. **Named arguments:** Use named arguments for readability in method calls with three or more parameters, or when boolean flags are present (e.g., `value: 1`, `repeat: FALSE`).
3. **First-class callables:** Replace string-based callbacks (`[$this, 'method']` or `'className::method'`) with first-class callable syntax (`$this->method(...)`).
4. **New Array Functions (PHP 8.4):** Prefer `array_find()`, `array_find_key()`, `array_any()`, and `array_all()` over complex `array_filter()` iterations when searching for specific elements or conditions.

### D. Drupal Integration
1. **Strict Dependency Injection:** Never use `\Drupal::service()` inside classes. Use `#[\Autowire]` or `create()` with `ContainerInterface`.
2. **Attributes over Annotations:** Use native PHP attributes (`#[Block]`, `#[Action]`, `#[QueueWorker]`) for plugin discovery.
3. **Service Decoration:** Favor service decoration to augment core behavior rather than creating wide hook overrides.

---

## Retrieval Modes & Intent

To ensure you are fetching the right context before writing code, use the following search strategies:

1. **Before writing a state machine or status field:** Search for existing Enums in the project (`enum *`).
2. **Before injecting a new dependency:** Check if the service is already passed in the constructor, or search the `.services.yml` for existing interfaces (`*Interface`).
3. **Before creating a plugin:** Search for the specific base class and modern attribute usage (e.g., `#[Block]`).
4. **Before overriding core behavior:** Search for existing service decorators or event subscribers instead of `hook_*_alter()`.

---

## Persistence & Write Rules

To maintain high-quality project memory, apply the following gates when documenting design decisions:

- **MUST PERSIST:** The rationale for making a class mutable instead of `readonly`.
- **MUST PERSIST:** The justification for using a `switch` statement instead of a `match` expression due to required side effects.
- **MUST NOT PERSIST:** Routine DI additions (e.g., "Added EntityTypeManager to constructor").
- **SHOULD PERSIST:** The introduction of a new architectural Enum and its mapped states.

---

## Example Implementations

### Service with Asymmetric Visibility & Constructor Property Promotion
```php
<?php
declare(strict_types=1);

namespace Drupal\custom_module\Service;

use Drupal\Core\Entity\EntityTypeManagerInterface;
use Psr\Log\LoggerInterface;

final readonly class ContentProcessor {
  public function __construct(
    private EntityTypeManagerInterface $entityTypeManager,
    private LoggerInterface $logger,
  ) {}

  public function process(string $id): void {
     // Implementation
  }
}
```

### Property Hooks / Asymmetric Visibility (PHP 8.4)
```php
<?php
declare(strict_types=1);

namespace Drupal\custom_module\Model;

final class ArticleDto {
  public private(set) ContentStatus $status;
  
  public function __construct(string $title, ContentStatus $status) {
    $this->status = $status;
  }
}
```

### Enums & Match Expressions
```php
<?php
declare(strict_types=1);

namespace Drupal\custom_module\Enum;

enum ContentStatus: string {
  case Draft = 'draft';
  case Published = 'published';
  case Archived = 'archived';

  public function label(): string {
    return match($this) {
      self::Draft => 'Draft',
      self::Published => 'Published',
      self::Archived => 'Archived',
    };
  }
}
```

---

## Anti-Patterns to Avoid

- Using `mixed` types without explicit documentation and justification.
- Leaking internal state through public mutable properties when asymmetric visibility is applicable.
- Global scope dependency via `\Drupal` static calls in classes.
- Untyped class constants (use typed constants: `public const string BASE_URL = '...';`).
- Writing manual iterative loops when `array_find` or `array_any` is clearer.

---

## References

- Read `references/dry-run.md` for a worked refactoring example.
