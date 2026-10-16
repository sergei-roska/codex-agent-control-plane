<?php

namespace Drupal\test_module\Controller;

use Drupal\Core\Controller\ControllerBase;

class TestController extends ControllerBase {
    public function hello() {
        return [
            '#markup' => 'Hello World!',
        ];
    }
}
