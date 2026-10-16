<?php

require_once __DIR__ . '/../src/ProjectRootResolver.php';
require_once __DIR__ . '/ProjectRootResolverTest.php';

use DrupalMcp\SharedArgs\Tests\ProjectRootResolverTest;

$test = new ProjectRootResolverTest();
$test->run();
