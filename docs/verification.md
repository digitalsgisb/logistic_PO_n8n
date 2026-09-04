# Verification record

Verified on 4 September 2026 with Node 24.12.0 on Windows.

## Completed checks

### Company branding and interface update

- The green sidebar now spans the full viewport height and is 280–320 pixels wide on larger desktops, with a 180-pixel company logo and a slow animated accent. The pale-green header contains the page location and account controls. Smaller screens use a 140-pixel logo in the header.
- Verified actual scrolling at a 1440 × 620 desktop viewport and 390/320-pixel mobile widths: the main content moves, the header remains at the top, and the desktop sidebar stays at the viewport edge with the header positioned beside it. The sidebar can scroll independently on short screens.
- Added the supplied company logo to the workspace and sign-in screens, with Digital Transformation Unit footer branding. The logo is bundled locally by Vite and included in the existing web Docker build.
- Reviewed desktop and mobile screenshots of sign-in and combined-workbook results. Browser checks at 1440, 768, 390, and 320 pixels found no horizontal overflow, broken images, or JavaScript errors.
- Verified file selection/removal, singular file count, disabled empty submission, combined-download links, expandable PO/source details, starting a new batch, and signing out using simulated API responses. These were interface checks, not a new live n8n extraction run.
- TypeScript checking and the production Vite build passed. Browser checks verified that the sidebar animation is active normally and disabled by reduced-motion preferences.

### Combined workbook update

- Rechecked the staged update before publishing: all 13 tests, TypeScript checking, and the production Vite build passed. The local npm launcher was unavailable, so the same test/build entry points were run directly with Node.
- Regenerated the combined sample from `TOYOTA PO.pdf` using fixture extraction values and inspected the rendered daily sheet and Remarks. All four POs and nine item lines are in one workbook. The photo is a layout reference; quantities and trip assignments follow the source POs (including Bukit Raja route `WM02-03`, which belongs to Trip 3).
- Thirteen local tests pass, including one download containing all four sample orders and nine quantities, original trip assignments, suffixed PO numbers in Remarks, blank KB rows, duplicate uploads, and restart/retry without doubled quantities.
- Shared item/trip totals, multiple delivery dates in one workbook, copied sheet merges and print settings, and more than three PO numbers in one trip are covered.
- The combined layout was generated from the supplied PDF text with the known extraction fixtures and visually reviewed. This output change does not modify the extraction model or the existing n8n workflow.
- The user reported successful processing through their deployed n8n instance before requesting this change. The earlier checks below describe the original per-order implementation.

### Original implementation

- TypeScript checking and production Vite build passed.
- Linux tests and both production Docker image builds passed in [GitHub Actions](https://github.com/digitalsgisb/logistic_PO_n8n/actions/runs/33833978028).
- Automated API and mapping tests passed, covering four orders and all nine line items, destination suffixes, source validation, PDF overlay deduplication, multi-page orders, duplicate uploads, partial success, restart/retry, authenticated downloads, ZIP generation, and stale callbacks.
- Live Ollama extraction ran against the user's AI Atom server at `100.109.37.96:11434` using `glm-4.7-flash:q8_0`.
- All extracted fields and all nine item lines exactly matched the expected sample fixtures. Four output workbooks were generated and their cell mappings checked.
- The template and representative Shah Alam/Bukit Raja outputs were rendered and visually inspected. Full KB identifiers stay within their columns.
- Desktop (1440 pixels) and mobile (390 pixels) browser checks covered login, file selection, removal, disabled empty submission, and responsive layout. No browser JavaScript errors or horizontal mobile overflow were detected.

## Deployment status

The application is prepared for GitHub and Docker deployment. The development computer has no Docker Engine or LibreOffice installation. The bundled template uses the documented BIFF style-preserving preparation fallback; the normal LibreOffice regeneration script is supplied.

SSH to the AI Atom server was reachable, but `sugidigital` authentication was unavailable. The user chose GitHub-based deployment. Starting the stack on that server and activation of the imported workflow on the existing n8n instance still require the deployment steps in the README. The live Ollama test is not represented as an end-to-end run through the user's n8n instance.
