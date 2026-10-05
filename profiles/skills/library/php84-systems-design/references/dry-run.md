# Dry Run: PHP 8.4 Systems Design

## Example Task

Refactor a legacy Drupal service from procedural hook-based logic to modern PHP 8.4 class-based architecture.

## Before (legacy)

- Business logic inside `my_module.module` `hook_entity_presave()`.
- Uses `\Drupal::service()` static calls.
- String constants for status values (`'draft'`, `'published'`).
- Untyped properties, no `strict_types`.

## Applied Patterns

1. Extract logic into `src/EntityPresaveHandler.php` service.
2. Add `declare(strict_types=1)`.
3. Constructor property promotion with `readonly`.
4. Replace string constants with `ContentStatus` backed enum.
5. Replace `switch` with `match` expression.
6. Register service in `services.yml` with typed interface arguments.
7. Thin hook in `.module` delegates to `class_resolver`.
8. Using PHP 8.4 asymmetric visibility `public private(set)` for state that doesn't need to be fully readonly but can only be mutated internally.

## After

```php
<?php
declare(strict_types=1);

namespace Drupal\my_module;

use Drupal\Core\Entity\EntityInterface;
use Drupal\Core\Entity\EntityTypeManagerInterface;
use Drupal\node\NodeInterface;
use Psr\Log\LoggerInterface;
use Drupal\my_module\Enum\ContentStatus;

final class EntityPresaveHandler {
  public private(set) int $processedCount = 0;

  public function __construct(
    private readonly EntityTypeManagerInterface $entityTypeManager,
    private readonly LoggerInterface $logger,
  ) {}

  public function handle(EntityInterface $entity): void {
    if (!$entity instanceof NodeInterface) {
      return;
    }
    
    $action = match(ContentStatus::from($entity->get('field_status')->value)) {
      ContentStatus::Draft => $this->saveDraft($entity),
      ContentStatus::Published => $this->publish($entity),
      ContentStatus::Archived => $this->archive($entity),
    };

    $this->processedCount++;
  }
}
```

## Verification

- PHPStan Level 8: passes with no errors.
- PHPCS Drupal,DrupalPractice: clean.
- Runtime behavior: identical to before — verified by existing tests.
- `\Drupal::service()` calls: 0 in refactored code.
