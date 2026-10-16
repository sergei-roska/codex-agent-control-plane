<?php

namespace Drupal\test_module\Form;

use Drupal\Core\Form\FormBase;

class TestForm extends FormBase {
    public function getFormId() {
        return 'test_module_test_form';
    }

    public function buildForm(array $form, array &$form_state) {
        $form['name'] = [
            '#type' => 'textfield',
            '#title' => 'Name',
        ];
        return $form;
    }

    public function submitForm(array &$form, array &$form_state) {
        // Submit logic
    }
}
