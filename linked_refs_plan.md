# Linked References Implementation Plan

## What will be implemented

### 1. Enhanced `getBacklinks()` 
- Collect full block context for each reference (breadcrumb path from page root → referencing block)
- Include children of the referencing block
- Group results by source page

### 2. Rewritten `renderBacklinks()`
- **Count badge** at the top: "X Linked References"
- **Page groups** (collapsible per source page):
  - Page name header → clickable → navigates to that page
  - Shows all referencing blocks from that page
  - Each block item shows:
    - Breadcrumb: "PageTitle > Parent Block > ..."
    - Block content with [[CurrentPage]] highlighted
    - Child blocks indented below (if any)
- **Unlinked References** section (collapsible as a whole):
  - Same structure as linked
  - "Link" button to convert

### 3. New CSS for linked references panel
- Page group headers with collapse chevrons
- Highlighted mention chip
- Breadcrumb path display
- Block preview card styling
- Child indent within ref view
- Count badge
