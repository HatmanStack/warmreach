#!/bin/bash
# Automated Sanitization Module
# Finds console.log, print statements, debugger, TODO comments for audit

# Global variable for sanitization findings
SANITIZATION_FINDINGS=""

# Initialize sanitization findings
init_sanitization_findings() {
    SANITIZATION_FINDINGS='{
        "consoleLogs": [],
        "printStatements": [],
        "debuggerStatements": [],
        "todoComments": []
    }'
}

# Find console.log statements (audit only - no auto-removal for safety)
remove_console_logs() {
    echo "  → Finding console.log statements..."

    local count=0
    local output_file="$REPORT_DIR/sanitize-console-$TIMESTAMP.txt"

    # Find all JS/TS files (excluding tests and node_modules)
    find "$REPO_ROOT/frontend/src" "$REPO_ROOT/client/src" \
        -type f \( -name "*.js" -o -name "*.ts" -o -name "*.tsx" \) \
        ! -name "*.test.*" ! -name "*.spec.*" \
        -exec grep -l 'console\.\(log\|warn\|debug\|info\)' {} \; 2>/dev/null > "$output_file" || true

    count=$(wc -l < "$output_file" 2>/dev/null || echo "0")
    count="${count//[[:space:]]/}"

    echo "    ✓ Found $count files with console statements (for manual review)"
    if [[ $count -gt 0 ]]; then
        echo "    Report: $output_file"
    fi
}

# Find Python print statements (audit only)
remove_print_statements() {
    echo "  → Finding print statements..."

    local count=0
    local output_file="$REPORT_DIR/sanitize-print-$TIMESTAMP.txt"

    # Find all Python files (excluding tests and .aws-sam)
    find "$REPO_ROOT/backend/lambdas" \
        -type f -name "*.py" \
        ! -path "*/.aws-sam/*" ! -path "*/__pycache__/*" \
        ! -name "*_test.py" ! -name "test_*.py" \
        -exec grep -l '^[[:space:]]*print(' {} \; 2>/dev/null > "$output_file" || true

    count=$(wc -l < "$output_file" 2>/dev/null || echo "0")
    count="${count//[[:space:]]/}"

    echo "    ✓ Found $count files with print statements (for manual review)"
    if [[ $count -gt 0 ]]; then
        echo "    Report: $output_file"
    fi
}

# Find debugger/breakpoint statements (audit only)
remove_debugger_statements() {
    echo "  → Finding debugger statements..."

    local output_file="$REPORT_DIR/sanitize-debugger-$TIMESTAMP.txt"

    # Find JS debugger statements
    find "$REPO_ROOT/frontend/src" "$REPO_ROOT/client/src" \
        -type f \( -name "*.js" -o -name "*.ts" -o -name "*.tsx" \) \
        ! -name "*.test.*" ! -name "*.spec.*" \
        -exec grep -l 'debugger' {} \; 2>/dev/null > "$output_file" || true

    # Find Python breakpoint/pdb statements
    find "$REPO_ROOT/backend/lambdas" \
        -type f -name "*.py" \
        ! -path "*/.aws-sam/*" ! -path "*/__pycache__/*" \
        -exec grep -l 'breakpoint()\|pdb\.set_trace()' {} \; 2>/dev/null >> "$output_file" || true

    local total_count
    total_count=$(wc -l < "$output_file" 2>/dev/null || echo "0")
    total_count="${total_count//[[:space:]]/}"

    echo "    ✓ Found $total_count files with debugger/breakpoint statements"
}

# Identify TODO/FIXME comments for audit (does not remove)
find_todo_comments() {
    echo "  → Finding TODO/FIXME comments..."

    local count=0
    local output_file="$REPORT_DIR/sanitize-todo-$TIMESTAMP.txt"

    # Find TODO/FIXME in JS/TS
    find "$REPO_ROOT/frontend/src" "$REPO_ROOT/client/src" \
        -type f \( -name "*.js" -o -name "*.ts" -o -name "*.tsx" \) \
        -exec grep -l 'TODO\|FIXME\|XXX\|HACK' {} \; 2>/dev/null > "$output_file" || true

    # Find TODO/FIXME in Python
    find "$REPO_ROOT/backend/lambdas" \
        -type f -name "*.py" \
        ! -path "*/.aws-sam/*" \
        -exec grep -l 'TODO\|FIXME\|XXX\|HACK' {} \; 2>/dev/null >> "$output_file" || true

    count=$(wc -l < "$output_file" 2>/dev/null || echo "0")
    count="${count//[[:space:]]/}"

    echo "    ✓ Found $count files with TODO/FIXME comments (for manual review)"
    if [[ $count -gt 0 ]]; then
        echo "    Report: $output_file"
    fi
}

# Get sanitization findings
get_sanitization_findings() {
    echo "$SANITIZATION_FINDINGS"
}

# Initialize on source
init_sanitization_findings
