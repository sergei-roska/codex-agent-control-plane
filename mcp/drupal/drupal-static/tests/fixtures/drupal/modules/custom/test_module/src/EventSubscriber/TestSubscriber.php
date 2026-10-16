<?php

namespace Drupal\test_module\EventSubscriber;

use Symfony\Component\EventDispatcher\EventSubscriberInterface;
use Symfony\Component\HttpKernel\KernelEvents;

class TestSubscriber implements EventSubscriberInterface {
    public static function getSubscribedEvents() {
        return [
            KernelEvents::REQUEST => 'onRequest',
            'custom_event_name' => 'onCustomEvent',
        ];
    }

    public function onRequest($event) {
        // Event logic
    }

    public function onCustomEvent($event) {
        // Custom event logic
    }
}
