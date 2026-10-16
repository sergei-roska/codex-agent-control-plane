<?php

namespace DrupalMcp\SharedArgs\Tests;

use DrupalMcp\SharedArgs\ProjectRootResolver;

class ProjectRootResolverTest {
    private string $tempDir;

    public function __construct() {
        $this->tempDir = sys_get_temp_dir() . '/mcp_forge_tests_' . uniqid();
    }

    public function run(): void {
        echo "Starting ProjectRootResolverTest...\n";
        $this->setUp();

        try {
            $this->testIsDrupalProject();
            $this->testEnvOverride();
            $this->testCliOverrideEquals();
            $this->testCliOverrideSpace();
            $this->testPrecedence();
            $this->testInstallRelative();
            $this->testCwdWalkUp();
            $this->testDrupalRootDetection();
            $this->testFailSafe();
            echo "[PASS] All ProjectRootResolver tests passed!\n";
        } finally {
            $this->tearDown();
        }
    }

    private function setUp(): void {
        if (!mkdir($this->tempDir, 0777, true)) {
            throw new \RuntimeException("Failed to create temp dir: " . $this->tempDir);
        }
    }

    private function tearDown(): void {
        $this->recursiveDelete($this->tempDir);
    }

    private function recursiveDelete(string $dir): void {
        if (!is_dir($dir)) {
            return;
        }
        $files = array_diff(scandir($dir), ['.', '..']);
        foreach ($files as $file) {
            $path = $dir . '/' . $file;
            if (is_dir($path)) {
                $this->recursiveDelete($path);
            } else {
                unlink($path);
            }
        }
        rmdir($dir);
    }

    private function createMockProject(string $name, array $structure): string {
        $projectPath = $this->tempDir . '/' . $name;
        mkdir($projectPath, 0777, true);
        foreach ($structure as $item) {
            $path = $projectPath . '/' . $item;
            if (str_ends_with($item, '/')) {
                mkdir($path, 0777, true);
            } else {
                $dir = dirname($path);
                if (!is_dir($dir)) {
                    mkdir($dir, 0777, true);
                }
                file_put_contents($path, '{}');
            }
        }
        return realpath($projectPath);
    }

    private function assert(bool $condition, string $message): void {
        if (!$condition) {
            throw new \RuntimeException("Assertion failed: " . $message);
        }
    }

    private function assertException(callable $callback, string $expectedMessagePart): void {
        try {
            $callback();
            throw new \RuntimeException("Expected exception was not thrown.");
        } catch (\Exception $e) {
            if (strpos($e->getMessage(), $expectedMessagePart) === false) {
                throw new \RuntimeException("Expected exception message containing '{$expectedMessagePart}', got '{$e->getMessage()}'");
            }
        }
    }

    public function testIsDrupalProject(): void {
        // Valid structure with web/core
        $proj1 = $this->createMockProject('proj1', ['composer.json', 'web/core/']);
        $this->assert(ProjectRootResolver::isDrupalProject($proj1), "proj1 should be a valid Drupal project");

        // Valid structure with docroot/core
        $proj2 = $this->createMockProject('proj2', ['composer.json', 'docroot/core/']);
        $this->assert(ProjectRootResolver::isDrupalProject($proj2), "proj2 should be a valid Drupal project");

        // Valid structure with core
        $proj3 = $this->createMockProject('proj3', ['composer.json', 'core/']);
        $this->assert(ProjectRootResolver::isDrupalProject($proj3), "proj3 should be a valid Drupal project");

        // Invalid: missing composer.json
        $proj4 = $this->createMockProject('proj4', ['web/core/']);
        $this->assert(!ProjectRootResolver::isDrupalProject($proj4), "proj4 should not be a valid Drupal project due to missing composer.json");

        // Invalid: missing core directory
        $proj5 = $this->createMockProject('proj5', ['composer.json']);
        $this->assert(!ProjectRootResolver::isDrupalProject($proj5), "proj5 should not be a valid Drupal project due to missing core folder");
    }

    public function testEnvOverride(): void {
        $proj = $this->createMockProject('env_proj', ['composer.json', 'web/core/']);
        
        // Clean environment
        putenv('PROJECT_ROOT');
        putenv('DRUPAL_ROOT');

        // Test valid env override
        putenv("PROJECT_ROOT=" . $proj);
        $res = ProjectRootResolver::resolve();
        $this->assert($res['project_root'] === $proj, "Should resolve project_root from ENV");
        
        // Test invalid env override
        putenv("PROJECT_ROOT=" . $this->tempDir);
        $this->assertException(function() {
            ProjectRootResolver::resolve();
        }, "Explicit PROJECT_ROOT does not point to a valid Drupal project");

        // Cleanup
        putenv('PROJECT_ROOT');
    }

    public function testCliOverrideEquals(): void {
        $proj = $this->createMockProject('cli_proj_eq', ['composer.json', 'web/core/']);
        
        // Clean environment
        putenv('PROJECT_ROOT');
        putenv('DRUPAL_ROOT');

        // Test valid CLI argument with =
        $argv = ['server.php', '--project-root=' . $proj];
        $res = ProjectRootResolver::resolve($argv);
        $this->assert($res['project_root'] === $proj, "Should resolve project_root from CLI --project-root=path");

        // Test invalid CLI argument with =
        $argv = ['server.php', '--project-root=' . $this->tempDir];
        $this->assertException(function() use ($argv) {
            ProjectRootResolver::resolve($argv);
        }, "Explicit --project-root does not point to a valid Drupal project");
    }

    public function testCliOverrideSpace(): void {
        $proj = $this->createMockProject('cli_proj_sp', ['composer.json', 'web/core/']);
        
        // Clean environment
        putenv('PROJECT_ROOT');
        putenv('DRUPAL_ROOT');

        // Test valid CLI argument with space
        $argv = ['server.php', '--project-root', $proj];
        $res = ProjectRootResolver::resolve($argv);
        $this->assert($res['project_root'] === $proj, "Should resolve project_root from CLI --project-root path");

        // Test invalid CLI argument with space
        $argv = ['server.php', '--project-root', $this->tempDir];
        $this->assertException(function() use ($argv) {
            ProjectRootResolver::resolve($argv);
        }, "Explicit --project-root does not point to a valid Drupal project");

        // Test missing CLI value
        $argv = ['server.php', '--project-root'];
        $this->assertException(function() use ($argv) {
            ProjectRootResolver::resolve($argv);
        }, "Explicit --project-root option is missing a value");
    }

    public function testPrecedence(): void {
        $projEnv = $this->createMockProject('prec_env', ['composer.json', 'web/core/']);
        $projCli = $this->createMockProject('prec_cli', ['composer.json', 'web/core/']);
        
        // Both env and CLI argument specified
        putenv("PROJECT_ROOT=" . $projEnv);
        $argv = ['server.php', '--project-root=' . $projCli];
        
        $res = ProjectRootResolver::resolve($argv);
        $this->assert($res['project_root'] === $projEnv, "PROJECT_ROOT environment variable should win over CLI argument");

        // Clean up env
        putenv('PROJECT_ROOT');
    }

    public function testInstallRelative(): void {
        // Create mock vendor structure
        // /vendor/drupal-mcp/drupal-static/bin/
        $proj = $this->createMockProject('install_rel', [
            'composer.json',
            'web/core/',
            'vendor/drupal-mcp/drupal-static/bin/'
        ]);
        $entryPoint = $proj . '/vendor/drupal-mcp/drupal-static/bin';

        // Clean environment
        putenv('PROJECT_ROOT');
        putenv('DRUPAL_ROOT');

        $res = ProjectRootResolver::resolve(null, $entryPoint);
        $this->assert($res['project_root'] === $proj, "Should resolve project root relative to entryPoint vendor folder");
    }

    public function testCwdWalkUp(): void {
        $proj = $this->createMockProject('cwd_proj', [
            'composer.json',
            'web/core/',
            'some/deep/nested/folder/'
        ]);
        
        $deepFolder = $proj . '/some/deep/nested/folder';
        $originalCwd = getcwd();

        // Clean environment
        putenv('PROJECT_ROOT');
        putenv('DRUPAL_ROOT');

        chdir($deepFolder);
        try {
            $res = ProjectRootResolver::resolve();
            $this->assert($res['project_root'] === $proj, "Should resolve project root by walking up from CWD");
        } finally {
            chdir($originalCwd);
        }
    }

    public function testDrupalRootDetection(): void {
        putenv('PROJECT_ROOT');
        putenv('DRUPAL_ROOT');

        // Case 1: web/core exists -> drupal_root is web
        $proj1 = $this->createMockProject('dr_web', ['composer.json', 'web/core/']);
        putenv("PROJECT_ROOT=" . $proj1);
        $res1 = ProjectRootResolver::resolve();
        $this->assert($res1['drupal_root'] === $proj1 . '/web', "drupal_root should be web/ when web/core exists");

        // Case 2: docroot/core exists -> drupal_root is docroot
        $proj2 = $this->createMockProject('dr_docroot', ['composer.json', 'docroot/core/']);
        putenv("PROJECT_ROOT=" . $proj2);
        $res2 = ProjectRootResolver::resolve();
        $this->assert($res2['drupal_root'] === $proj2 . '/docroot', "drupal_root should be docroot/ when docroot/core exists");

        // Case 3: core exists in project root -> drupal_root is project root
        $proj3 = $this->createMockProject('dr_root', ['composer.json', 'core/']);
        putenv("PROJECT_ROOT=" . $proj3);
        $res3 = ProjectRootResolver::resolve();
        $this->assert($res3['drupal_root'] === $proj3, "drupal_root should be project_root when core/ exists directly in project root");

        // Case 4: Explicit valid DRUPAL_ROOT env override
        $proj4 = $this->createMockProject('dr_explicit', ['composer.json', 'web/core/']);
        putenv("PROJECT_ROOT=" . $proj4);
        $customDrupalDir = $this->tempDir . '/custom_drupal_dir';
        mkdir($customDrupalDir);
        putenv("DRUPAL_ROOT=" . $customDrupalDir);
        $res4 = ProjectRootResolver::resolve();
        $this->assert($res4['drupal_root'] === realpath($customDrupalDir), "drupal_root should use DRUPAL_ROOT env override");

        // Case 5: Explicit invalid DRUPAL_ROOT env override
        putenv("DRUPAL_ROOT=" . $this->tempDir . '/non_existent_folder');
        $this->assertException(function() {
            ProjectRootResolver::resolve();
        }, "Explicit DRUPAL_ROOT does not point to a valid directory");

        putenv('PROJECT_ROOT');
        putenv('DRUPAL_ROOT');
    }

    public function testFailSafe(): void {
        putenv('PROJECT_ROOT');
        putenv('DRUPAL_ROOT');

        // We run in a temp dir that is NOT a project root, nor has mock vendors/cwd matching a project
        $nonProjectDir = $this->tempDir . '/non_project';
        mkdir($nonProjectDir);
        $originalCwd = getcwd();
        chdir($nonProjectDir);

        try {
            $this->assertException(function() use ($nonProjectDir) {
                ProjectRootResolver::resolve(null, $nonProjectDir);
            }, "PROJECT_ROOT could not be resolved.");
        } finally {
            chdir($originalCwd);
        }
    }
}
