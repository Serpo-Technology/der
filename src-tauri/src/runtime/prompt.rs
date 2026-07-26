//! The model-facing compose prompt: the Rust twin of buildBasePrompt and
//! renderCatalogText in contract-builder.ts. Byte parity with the webview
//! prompt is held by the compose vectors; the catalog renders from the
//! embedded registry snapshot plus the installed vocabulary passed per call.

use serde_json::Value;

use super::compose::{recipe_check_ok, ComposeVocabulary};
use super::manifests;
use super::value::{js_to_string, js_truthy};

pub const CREATE_PROMPT_SECTION: &str = r#"CREATE MODE:
You are given a user's request for a new app. Respond with ONE JSON object:
{ "spec": { "goal": "one sentence stating what the app does", "assumptions": ["choice you made where the request was open"], "openQuestions": ["question whose answer would change the app"] }, "contract": <the contract> }
When the catalog has an INSTALLED APPS section and the request asks for what one of those apps already is (same purpose, nothing the app lacks), respond { "spec": <as above>, "recipe": "<name from INSTALLED APPS>" } INSTEAD of a contract: the installed app opens instantly and is already proven to work. The value of "recipe" is the app's exact dotted catalog name, the token before the quoted title (for a line '- apps.expense_tracker "Expense Tracker": ...' it is "apps.expense_tracker"); a title or an invented name is invalid. Record the reuse as a spec assumption. If the request needs anything the installed app does not do, compose the contract yourself. Never respond with both "contract" and "recipe".
Make reasonable choices instead of blocking on questions; record them as assumptions. Keep both lists short; they are often empty. Return the JSON only: no prose, no code fences."#;

pub const BLUEPRINT_PROMPT_SECTION: &str = r#"BLUEPRINT MODE:
You are given a reviewed blueprint (goal, planned elements and operations). Produce the contract that realizes it, following the blueprint's intent even where you would design differently. Return the contract JSON object only: no prose, no code fences."#;

pub const EDIT_PROMPT_SECTION: &str = r#"EDIT MODE:
You are updating an EXISTING app, given its current contract and a change request. Return the COMPLETE updated contract JSON only: no prose, no code fences.
- Change only what the instruction requires; keep everything else exactly as it is.
- Keep the ids of every element and operation you retain. State is keyed by these ids; a changed id loses the user's data. Give NEW parts new ids.
- Keep existing initialState keys and their seeds; new state keys follow rule 1 (seed only what needs a non-empty start).
- Removing parts the instruction makes obsolete is fine; do not remove anything else."#;

const FULL_EXAMPLE_SECTION: &str = r#"EXAMPLE CONTRACT (expense tracker; the derived total and count need no operations, everything empty or derivable is omitted, and "expenses" needs no seed because list.append writes it):
{
  "name": "expense-tracker",
  "version": "1.0.0",
  "elements": [
    { "id": "title", "type": "text", "properties": { "content": "Expenses", "role": "title" } },
    { "id": "entry", "type": "container", "properties": { "direction": "row", "gap": "8", "align": "end" }, "children": [
      { "id": "desc-in", "type": "input", "properties": { "placeholder": "Description", "label": "What" } },
      { "id": "amt-in", "type": "input", "properties": { "placeholder": "0.00", "type": "number", "label": "Amount" } },
      { "id": "add-btn", "type": "button", "properties": { "text": "Add", "variant": "primary" }, "eventBindings": [ { "event": "click", "operationId": "op-add" } ] } ] },
    { "id": "rows", "type": "list", "properties": { "emptyText": "No expenses yet" },
      "dataBindings": [ { "property": "items", "source": "state", "sourceId": "expenses" } ],
      "children": [
        { "id": "r-desc", "type": "text", "dataBindings": [ { "property": "content", "source": "item", "sourceId": "description" } ] },
        { "id": "r-amt", "type": "text", "properties": { "role": "caption" }, "dataBindings": [ { "property": "content", "source": "item", "sourceId": "amount", "transforms": [ { "type": "round", "parameters": { "decimals": 2 } }, { "type": "format", "parameters": { "template": "$ {{value}}" } } ] } ] },
        { "id": "r-del", "type": "button", "properties": { "text": "Delete", "variant": "danger", "size": "sm" }, "eventBindings": [ { "event": "click", "operationId": "op-del" } ] } ] },
    { "id": "summary", "type": "container", "properties": { "direction": "row", "justify": "between" }, "visibleWhen": { "source": "state", "sourceId": "expenses", "operator": "notEmpty" }, "children": [
      { "id": "count", "type": "text", "properties": { "role": "caption" }, "dataBindings": [ { "property": "content", "source": "state", "sourceId": "expenses", "transforms": [ { "type": "count", "parameters": {} }, { "type": "format", "parameters": { "template": "{{value}} expenses" } } ] } ] },
      { "id": "total", "type": "text", "properties": { "role": "subtitle" }, "dataBindings": [ { "property": "content", "source": "state", "sourceId": "expenses", "transforms": [ { "type": "sum", "parameters": { "field": "amount" } }, { "type": "round", "parameters": { "decimals": 2 } }, { "type": "format", "parameters": { "template": "Total: $ {{value}}" } } ] } ] } ] }
  ],
  "operations": [
    { "id": "op-add", "operationName": "list.append",
      "inputs": [
        { "name": "key", "source": "constant", "sourceId": "expenses" },
        { "name": "item.description", "source": "ui-element", "sourceId": "desc-in" },
        { "name": "item.amount", "source": "ui-element", "sourceId": "amt-in", "transforms": [ { "type": "parseNumber", "parameters": {} } ] } ],
      "outputs": [
        { "name": "reset", "target": "ui-element", "targetId": "desc-in" },
        { "name": "reset", "target": "ui-element", "targetId": "amt-in" } ] },
    { "id": "op-del", "operationName": "list.removeWhere",
      "inputs": [
        { "name": "key", "source": "constant", "sourceId": "expenses" },
        { "name": "value", "source": "item", "sourceId": "id" } ] }
  ]
}"#;

const COMPACT_EXAMPLE_SECTION: &str = r#"EXAMPLE CONTRACT (click counter; everything empty or derivable is omitted):
{
  "name": "click-counter",
  "version": "1.0.0",
  "elements": [
    { "id": "count-text", "type": "text", "properties": { "role": "title" }, "dataBindings": [ { "property": "content", "source": "state", "sourceId": "clicks", "transforms": [ { "type": "format", "parameters": { "template": "Clicks: {{value}}" } } ] } ] },
    { "id": "click-btn", "type": "button", "properties": { "text": "Click", "variant": "primary" }, "eventBindings": [ { "event": "click", "operationId": "op-add" } ] }
  ],
  "operations": [
    { "id": "op-add", "operationName": "counter.add", "inputs": [ { "name": "key", "source": "constant", "sourceId": "clicks" } ] }
  ]
}"#;

const BASE_PROMPT_HEAD: &str = r##"You compose a Contract JSON from prewritten parts; a runtime renders it into a live interactive app. You configure parts; you NEVER write code.

CONTRACT SHAPE (omit every field marked ?, every empty array or object, and every default):
{
  "name": "kebab-case-name",
  "version": "1.0.0",
  "initialState"?: { "<stateKey>": <seed> },
  "elements": [ { "id", "type", "properties"?, "dataBindings"?, "eventBindings"?, "visibleWhen"?, "children"? } ],
  "operations": [ { "id", "operationName", "inputs"?, "outputs"?, "implementation"? } ],
  "styling"?: { "theme": "default" | "dark" | "paper" | "terminal", "accent"?: "blue" | "green" | "violet" | "rose" | "amber" | "cyan" | "#RRGGBB", "background"?: "#RRGGBB" }
}
Never emit "metadata", "triggers", "executionType", or "layout": the runtime derives them (executionType from the operation name, or remote when "implementation" carries an endpoint; the default layout is a padded 12px column). Omit "styling" for the standard light look; set a theme or accent when the user asks for one or the app's character clearly calls for it, e.g. "terminal" for a developer tool or "paper" for a journal. When the user names a color, use the closest palette accent, or set the accent to a fitting hex color like "#7c3aed" when the palette lacks it. When the user asks for a color scheme the theme presets lack (a yellow look, a mint window), set "background" to a fitting hex: the runtime derives panels, borders, and readable text from it, and it combines freely with any accent.

RUNTIME RULES (follow exactly):
1. State is a flat map. Operations write it; display elements read it with dataBindings {"property", "source": "state", "sourceId": "<stateKey>"}. Unwritten keys start empty (arrays read as []); add an "initialState" entry only when a key needs a non-empty start, e.g. a default tab name or preset options.
2. Inputs, selects, and checkboxes are auto-controlled. Give each an id; NEVER bind its value. Operations read them with an InputBinding {"name": "<param>", "source": "ui-element", "sourceId": "<element id>"}. Do not place them inside list children.
3. Wire interactions only with eventBindings on elements: {"event": "click" | "change" | "submit", "operationId": "<operation id>"}. Every operationId you reference MUST have a matching entry in the top-level "operations" array; the contract is incomplete without it.
4. A "list" element repeats its children once per entry of the array bound to its "items" property. Inside those children, read entry fields with source "item" and a dot-path sourceId (e.g. "title"; "" for the whole entry), including operation InputBindings {"source": "item", "sourceId": "id"}.
5. Other input sources: {"source": "state", "sourceId": "<stateKey>"} and {"source": "constant", "sourceId": "<text>"}. For non-string constants set the typed "value" field: {"source": "constant", "sourceId": "true", "value": true}. Outputs route results: {"name": "<output name>", "target": "state", "targetId": "<stateKey>"} or {"target": "ui-element", "targetId": "<element id>"} to set an element's value. Every operation also provides a "reset" output: route it to an input element to clear it after the run.
6. Structured operation inputs use dotted names: list.append takes one input per item field named "item.<field>" (never "item.id"; the part generates ids), list.updateWhere writes fields via "set.<field>". Use the parseNumber transform on numeric fields fed from text inputs.
7. Derived values need no operation: attach a "transforms" pipeline (applied in order) to a dataBinding, e.g. filterFalsy("completed") then count for "N left" (filterFalsy counts rows that never got the flag), or sum then round then format for totals. A pipeline feeding "content" must END in a single value (count, sum, pick, format); a filter alone yields a list and cannot display. PER-ROW math uses deriveField: {"type": "deriveField", "parameters": {"field": "value", "expression": "qty * price"}} computes the expression from EACH row's own fields and adds it as a new field. On the list's items binding, row templates then read it like any field ({"source": "item", "sourceId": "value"}); a total is the pipeline [deriveField, sum {"field": "value"}] on the same state key; an operation input needing those per-row numbers chains [deriveField, pluck {"field": "value"}]. A field like a row's stock value exists ONLY after deriveField creates it. Never approximate per-row products with separate aggregates: sum(qty) times an average price is wrong whenever rows differ. Transform parameter values are static, or LIVE references {"source": "state"|"element", "sourceId": "<key or element id>"}: a search box filtering a list is the items binding with transforms [{"type": "filterContains", "parameters": {"field": "title", "value": {"source": "element", "sourceId": "search-in"}}}]; the same works for filterBy category dropdowns and sortBy fields. A format template may carry extra {{name}} slots filled from same-named parameters (live references included), so combining several values is ONE step: {"type": "format", "parameters": {"template": "WIFI:T:WPA;S:{{value}};P:{{pw}};;", "pw": {"source": "element", "sourceId": "pass-in"}}}. Bindings re-resolve on every state change. Make toggled flags VISIBLE: bind the row text's "className" from the flag with a map transform, {"property": "className", "source": "item", "sourceId": "completed", "transforms": [{"type": "map", "parameters": {"mapping": {"true": "done", "false": ""}}}]}; the runtime strikes through elements classed "done".
8. Conditional rendering: "visibleWhen": {"source": "state"|"item", "sourceId", "operator": "truthy"|"falsy"|"empty"|"notEmpty"|"equals"|"notEquals"|"gt"|"gte"|"lt"|"lte", "value"?, "transforms"?}. "value" is a literal, or a live reference like transform parameters ({"source": "state"|"element", "sourceId"}). An array of conditions means all must hold. The tab pattern: initialState {"view": "first"}, one container per view gated by visibleWhen {"sourceId": "view", "operator": "equals", "value": "<name>"}, and tab buttons running state.set on "view". Master-detail: a row click runs state.set operations copying the item fields ({"source": "item", "sourceId": "<field>"}) into state keys a detail card binds.
9. Element knobs (variant, size, role, tone, direction, gap, align, justify, padding, surface, label, emptyText) are declared per part below; use only listed values. Give apps visible structure with them: entry rows and summary sections in surface "card" containers, highlight panels and key numbers with surface "accent" or tone "accent".
10. Time: a "timer" element fires its "tick" event on an interval while rendered; gate it with visibleWhen on a state flag and flip the flag with Start/Stop buttons (state.set) for pause control. time.now stamps the current date/time into state (chain it before a list.append on the same click to date entries). Date inputs use properties {"type": "date"}; ISO date strings sort and compare correctly; display any stamp with the formatDate transform.
11. A remote operation is configuration of an HTTP call: "implementation": {"type": "remote", "endpoint": "https://...", "method": "GET"|"POST", "headers"?}; "{name}" placeholders in the endpoint fill from same-named inputs, other inputs become query parameters (GET) or the JSON body. Builtin operations take an exact name from the catalog and no implementation. There is no way to include code and none is needed. Reach for remote only when the request genuinely involves external data or services; prefer composing builtin parts, and ALWAYS record any remote endpoint and what it is used for in the spec assumptions so the user sees the app calls out. For authenticated APIs set "auth" to one of the integration credential names in the catalog; NEVER write an API key or token into an endpoint, header, or input.

"##;

const BASE_PROMPT_TAIL: &str = r#"Every eventBinding.operationId must match an operation id; every part, knob value, operation, and transform must come from the catalog above. When an installed UI fragment covers a pattern you are about to build (an entry row, a stat tile), use the fragment element instead of assembling the same thing from raw elements. Design the smallest contract that fully satisfies the request."#;

pub fn build_base_prompt(catalog: &str, compact: bool) -> String {
    let example = if compact { COMPACT_EXAMPLE_SECTION } else { FULL_EXAMPLE_SECTION };
    format!("{}{}\n\n{}\n\n{}", BASE_PROMPT_HEAD, catalog, example, BASE_PROMPT_TAIL)
}

pub fn render_create_prompt(vocab: &ComposeVocabulary, description: &str, compact: bool) -> (String, String) {
    let system = format!(
        "{}\n\n{}",
        build_base_prompt(&render_catalog_text(vocab, compact), compact),
        CREATE_PROMPT_SECTION
    );
    let user = format!("Build an app for this request:\n\n{}", description);
    (system, user)
}

fn io_spec_line(spec: &Value, optional_marker: bool) -> String {
    let name = spec.get("name").and_then(Value::as_str).unwrap_or("");
    let kind = spec.get("type").and_then(Value::as_str).unwrap_or("");
    if optional_marker {
        let required = spec.get("required").and_then(Value::as_bool).unwrap_or(false);
        format!("{}{}: {}", name, if required { "" } else { "?" }, kind)
    } else {
        format!("{}: {}", name, kind)
    }
}

fn operation_lines(name: &str, def: &Value, compact: bool) -> Vec<String> {
    let inputs = def
        .get("inputs")
        .and_then(Value::as_array)
        .map(|specs| {
            specs
                .iter()
                .map(|spec| io_spec_line(spec, true))
                .collect::<Vec<_>>()
                .join(", ")
        })
        .filter(|joined| !joined.is_empty())
        .unwrap_or_else(|| "none".to_string());
    let outputs = def
        .get("outputs")
        .and_then(Value::as_array)
        .map(|specs| {
            specs
                .iter()
                .map(|spec| io_spec_line(spec, false))
                .collect::<Vec<_>>()
                .join(", ")
        })
        .filter(|joined| !joined.is_empty())
        .unwrap_or_else(|| "none".to_string());
    let description = def.get("description").and_then(Value::as_str).unwrap_or("");
    let mut lines = vec![format!(
        "- {} (inputs: {}; outputs: {}): {}",
        name, inputs, outputs, description
    )];
    if !compact {
        if let Some(howto) = def.get("howto").and_then(Value::as_str) {
            lines.push(format!("  howto: {}", howto));
        }
        if let Some(example) = def.get("example") {
            lines.push(format!(
                "  example: {}",
                serde_json::to_string(example).unwrap_or_default()
            ));
        }
    }
    lines
}

/// The part catalog rendered from the registry snapshot plus the installed
/// vocabulary. Compact drops howtos and examples.
pub fn render_catalog_text(vocab: &ComposeVocabulary, compact: bool) -> String {
    let registry = manifests::registry();

    let mut element_lines: Vec<String> = Vec::new();
    if let Some(elements) = registry.get("elements").and_then(Value::as_object) {
        for (element_type, manifest) in elements {
            let description = manifest.get("description").and_then(Value::as_str).unwrap_or("");
            element_lines.push(format!("- {}: {}", element_type, description));
            let knobs = manifest.get("knobs").and_then(Value::as_array).cloned().unwrap_or_default();
            if !knobs.is_empty() {
                let rendered = knobs
                    .iter()
                    .map(|knob| {
                        let name = knob.get("name").and_then(Value::as_str).unwrap_or("");
                        if knob.get("type").and_then(Value::as_str) == Some("enum") {
                            let values = knob
                                .get("values")
                                .and_then(Value::as_array)
                                .map(|values| {
                                    values
                                        .iter()
                                        .filter_map(Value::as_str)
                                        .collect::<Vec<_>>()
                                        .join("|")
                                })
                                .unwrap_or_default();
                            let default = knob
                                .get("default")
                                .map(js_to_string)
                                .unwrap_or_else(|| "undefined".to_string());
                            format!("{}: {} (default {})", name, values, default)
                        } else {
                            format!(
                                "{}: {}",
                                name,
                                knob.get("type").and_then(Value::as_str).unwrap_or("")
                            )
                        }
                    })
                    .collect::<Vec<_>>()
                    .join("; ");
                element_lines.push(format!("  knobs: {}", rendered));
            }
            let bindable = manifest
                .get("bindableProps")
                .and_then(Value::as_array)
                .map(|props| props.iter().filter_map(Value::as_str).collect::<Vec<_>>())
                .unwrap_or_default();
            if !bindable.is_empty() {
                element_lines.push(format!("  bindable: {}", bindable.join(", ")));
            }
            if !compact {
                let howto = manifest.get("howto").and_then(Value::as_str).unwrap_or("");
                element_lines.push(format!("  howto: {}", howto));
                if let Some(example) = manifest.get("example") {
                    element_lines.push(format!(
                        "  example: {}",
                        serde_json::to_string(example).unwrap_or_default()
                    ));
                }
            }
        }
    }

    let mut operation_catalog_lines: Vec<String> = Vec::new();
    if let Some(operations) = registry.get("operations").and_then(Value::as_object) {
        for (name, def) in operations {
            if def.get("hidden").is_some_and(js_truthy) {
                continue;
            }
            operation_catalog_lines.extend(operation_lines(name, def, compact));
        }
    }

    let mut ui_fragment_lines: Vec<String> = Vec::new();
    for (name, def) in &vocab.fragment_defs {
        let params = def.get("params").and_then(Value::as_array).cloned().unwrap_or_default();
        let rendered_params = params
            .iter()
            .map(|param| {
                let param_name = param.get("name").and_then(Value::as_str).unwrap_or("");
                let kind = param.get("type").and_then(Value::as_str).unwrap_or("");
                let required = param.get("required").is_some_and(js_truthy);
                let marker = if required { "!" } else { "?" };
                let default = param
                    .get("default")
                    .map(|value| {
                        format!(" (default {})", serde_json::to_string(value).unwrap_or_default())
                    })
                    .unwrap_or_default();
                format!("{}{}: {}{}", param_name, marker, kind, default)
            })
            .collect::<Vec<_>>()
            .join("; ");
        let usage_params = params
            .iter()
            .filter(|param| param.get("required").is_some_and(js_truthy))
            .map(|param| {
                format!(
                    "\"{}\": <{}>",
                    param.get("name").and_then(Value::as_str).unwrap_or(""),
                    param.get("type").and_then(Value::as_str).unwrap_or("")
                )
            })
            .collect::<Vec<_>>()
            .join(", ");
        let usage = format!(
            "{{\"id\": \"<id>\", \"type\": \"{}\", \"properties\": {{{}}}}}",
            name, usage_params
        );
        let description = def.get("description").and_then(Value::as_str).unwrap_or("");
        ui_fragment_lines.push(format!("- {}: {}", name, description));
        if !rendered_params.is_empty() {
            ui_fragment_lines.push(format!("  params: {}", rendered_params));
        }
        ui_fragment_lines.push(format!("  usage: {}", usage));
        let operations = def.get("operations").and_then(Value::as_array).cloned().unwrap_or_default();
        if !operations.is_empty() {
            // Self-wired packs: derive the state keys their operations write
            // so the model can read them from outside without guessing.
            let mut keys: Vec<String> = Vec::new();
            for op in &operations {
                for input in op.get("inputs").and_then(Value::as_array).into_iter().flatten() {
                    let is_key = input.get("name").and_then(Value::as_str) == Some("key")
                        && input.get("source").and_then(Value::as_str) == Some("constant");
                    let Some(source_id) = input.get("sourceId").and_then(Value::as_str) else {
                        continue;
                    };
                    if is_key && source_id.starts_with("{{id}}") {
                        let replaced = source_id.replacen("{{id}}", "<instance id>", 1);
                        if !keys.contains(&replaced) {
                            keys.push(replaced);
                        }
                    }
                }
            }
            let key_note = if keys.is_empty() {
                String::new()
            } else {
                format!(
                    "; it writes state keys {}, which other bindings and operation inputs may read",
                    keys.join(" and ")
                )
            };
            ui_fragment_lines.push(format!(
                "  self-wired: ships its own operations, so add NO operations and no operationId for it{}",
                key_note
            ));
        }
        if let Some(howto) = def.get("howto").and_then(Value::as_str) {
            ui_fragment_lines.push(format!("  howto: {}", howto));
        }
    }

    // Only HTTP-injectable credentials are taught as auth names; the store's
    // other kinds (the smtp mail account, part-scoped secrets) have their own
    // consumers.
    let mut credential_lines: Vec<String> = Vec::new();
    for cred in &vocab.credentials {
        let kind = cred.get("kind").and_then(Value::as_str).unwrap_or("");
        if !matches!(kind, "bearer" | "header" | "query") {
            continue;
        }
        let target = cred
            .get("target")
            .map(js_to_string)
            .unwrap_or_else(|| "undefined".to_string());
        let shape = match kind {
            "bearer" => "bearer token".to_string(),
            "header" => format!("header \"{}\"", target),
            _ => format!("query parameter \"{}\"", target),
        };
        let name = cred.get("name").and_then(Value::as_str).unwrap_or("");
        let base_url = cred.get("baseUrl").and_then(Value::as_str).unwrap_or("");
        let confinement = if base_url.is_empty() {
            String::new()
        } else {
            format!(": endpoints MUST start with {}", base_url)
        };
        credential_lines.push(format!("- {} ({}){}", name, shape, confinement));
        if let Some(notes) = cred.get("notes").and_then(Value::as_str) {
            credential_lines.push(format!("  service notes: {}", notes));
        }
    }

    let mut transform_lines: Vec<String> = Vec::new();
    for def in registry.get("transforms").and_then(Value::as_array).into_iter().flatten() {
        let name = def.get("name").and_then(Value::as_str).unwrap_or("");
        let params = def
            .get("parameters")
            .and_then(Value::as_array)
            .map(|names| names.iter().filter_map(Value::as_str).collect::<Vec<_>>().join(", "))
            .unwrap_or_default();
        let braced = if params.is_empty() { String::new() } else { format!(" {{{}}}", params) };
        if compact {
            transform_lines.push(format!("- {}{}", name, braced));
        } else {
            let description = def.get("description").and_then(Value::as_str).unwrap_or("");
            transform_lines.push(format!("- {}{}: {}", name, braced, description));
        }
    }

    // Installed recipes that still validate against the current vocabulary.
    // Sorted by name so the cached prompt prefix stays byte-stable.
    let mut valid_recipes: Vec<&Value> = vocab
        .recipes
        .values()
        .filter(|def| recipe_check_ok(def, vocab))
        .collect();
    valid_recipes.sort_by_key(|def| def.get("name").and_then(Value::as_str).unwrap_or("").to_string());
    let recipe_lines: Vec<String> = valid_recipes
        .iter()
        .map(|def| {
            let name = def.get("name").and_then(Value::as_str).unwrap_or("");
            let title = def.get("title").and_then(Value::as_str).unwrap_or("");
            let description = def.get("description").and_then(Value::as_str).unwrap_or("");
            let keywords = def
                .get("keywords")
                .and_then(Value::as_array)
                .map(|words| words.iter().filter_map(Value::as_str).collect::<Vec<_>>())
                .unwrap_or_default();
            let keyword_note = if keywords.is_empty() {
                String::new()
            } else {
                format!(" (keywords: {})", keywords.join(", "))
            };
            format!("- {} \"{}\": {}{}", name, title, description, keyword_note)
        })
        .collect();

    let mut fragment_op_lines: Vec<String> = Vec::new();
    for (name, def) in &vocab.part_operations {
        fragment_op_lines.extend(operation_lines(name, def, compact));
    }

    let mut sections: Vec<String> = Vec::new();
    sections.push("ELEMENT PARTS (compose these; plain HTML tag names are also accepted):".to_string());
    sections.extend(element_lines);
    sections.push(String::new());
    sections.push("BUILTIN OPERATIONS (use the exact name with executionType \"builtin\"):".to_string());
    sections.extend(operation_catalog_lines);
    sections.push(String::new());
    sections.push("TRANSFORMS (compose into \"transforms\" pipelines; applied in order):".to_string());
    sections.extend(transform_lines);
    if !fragment_op_lines.is_empty() {
        sections.push(String::new());
        sections.push(
            "INSTALLED PART OPERATIONS (use the exact name with executionType \"builtin\"):".to_string(),
        );
        sections.extend(fragment_op_lines);
    }
    if !credential_lines.is_empty() {
        sections.push(String::new());
        sections.push(
            "INTEGRATION CREDENTIALS (for remote operations: set implementation \"auth\" to a name below; the runtime injects the secret, which NEVER appears in the contract):"
                .to_string(),
        );
        sections.extend(credential_lines);
    }
    if !ui_fragment_lines.is_empty() {
        sections.push(String::new());
        sections.push(
            "COMPOSED UI FRAGMENTS (single elements the runtime expands; params go in \"properties\"). Prefer these over hand-building the same pattern from raw elements. Give every dashboard or summary number its own stat_tile in a row container instead of running them together as plain text:"
                .to_string(),
        );
        sections.extend(ui_fragment_lines);
    }
    if !recipe_lines.is_empty() {
        sections.push(String::new());
        sections.push("INSTALLED APPS (complete proven apps already on this machine):".to_string());
        sections.extend(recipe_lines);
    }
    sections.join("\n")
}
