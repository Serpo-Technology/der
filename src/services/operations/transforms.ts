/**
 * Transform metadata: the declarative derivations contracts may use in
 * binding pipelines and visibleWhen conditions. Execution lives in the
 * runtime kernel (der-runtime's transforms module); this registry keeps the
 * shapes for the catalog snapshot and tooling.
 */

export interface TransformParamSpec {
  name: string;
  type?: string;
  description?: string;
  default?: unknown;
  values?: string[];
}

export interface TransformDef {
  name: string;
  output: 'scalar' | 'array' | 'any';
  description: string;
  parameters: TransformParamSpec[];
}

export const TRANSFORMS: Record<string, TransformDef> = {
  "count": {
    "name": "count",
    "output": "scalar",
    "description": "Number of entries in an array (0 for anything else).",
    "parameters": []
  },
  "sum": {
    "name": "sum",
    "output": "scalar",
    "description": "Sum of a numeric field across an array of objects.",
    "parameters": [
      {
        "name": "field",
        "type": "string",
        "description": "Field to sum",
        "default": ""
      }
    ]
  },
  "filterBy": {
    "name": "filterBy",
    "output": "array",
    "description": "Keeps array entries whose field equals the given value; an empty value keeps everything, so an \"All\" dropdown option can use value \"\".",
    "parameters": [
      {
        "name": "field",
        "type": "string",
        "description": "Field to compare"
      },
      {
        "name": "value",
        "type": "string",
        "description": "Value to match"
      }
    ]
  },
  "filterContains": {
    "name": "filterContains",
    "output": "array",
    "description": "Keeps array entries whose field contains the given text, case-insensitive; empty text keeps everything. Bind value dynamically for live search.",
    "parameters": [
      {
        "name": "field",
        "type": "string",
        "description": "Field to search"
      },
      {
        "name": "value",
        "type": "string",
        "description": "Text to look for"
      }
    ]
  },
  "filterTruthy": {
    "name": "filterTruthy",
    "output": "array",
    "description": "Keeps array entries whose field is truthy (set flags, checked rows).",
    "parameters": [
      {
        "name": "field",
        "type": "string",
        "description": "Field to test"
      }
    ]
  },
  "filterFalsy": {
    "name": "filterFalsy",
    "output": "array",
    "description": "Keeps array entries whose field is falsy or missing (e.g. not-completed rows; a row that never got the flag counts).",
    "parameters": [
      {
        "name": "field",
        "type": "string",
        "description": "Field to test"
      }
    ]
  },
  "sortBy": {
    "name": "sortBy",
    "output": "array",
    "description": "Sorts an array by a field; numeric when both values are numbers.",
    "parameters": [
      {
        "name": "field",
        "type": "string",
        "description": "Field to sort by"
      },
      {
        "name": "direction",
        "type": "enum",
        "values": [
          "asc",
          "desc"
        ],
        "default": "asc",
        "description": "Sort direction"
      }
    ]
  },
  "deriveField": {
    "name": "deriveField",
    "output": "array",
    "description": "Adds a computed field to every row of an array: an arithmetic expression over that row's numeric fields (e.g. field \"value\", expression \"qty * price\"). Rows keep their other fields; read the new field like any row field, sum it for totals, or sortBy it.",
    "parameters": [
      {
        "name": "field",
        "type": "string",
        "description": "Name of the field to add"
      },
      {
        "name": "expression",
        "type": "string",
        "description": "Arithmetic over row fields: + - * / % ^, parentheses, sqrt/abs/floor/ceil/round, min/max/pow, pi, e"
      }
    ]
  },
  "groupSum": {
    "name": "groupSum",
    "output": "array",
    "description": "Groups an array of objects by a field and sums another per group; returns [{key, sum}] in first-seen order. The chart element's natural feed (x \"key\", y \"sum\").",
    "parameters": [
      {
        "name": "by",
        "type": "string",
        "description": "Field to group by"
      },
      {
        "name": "field",
        "type": "string",
        "description": "Numeric field to sum per group"
      }
    ]
  },
  "pick": {
    "name": "pick",
    "output": "any",
    "description": "Reads a field (dot path allowed) from an object; an array reads from its first entry, so filterBy then pick gives the matched entry's field.",
    "parameters": [
      {
        "name": "field",
        "type": "string",
        "description": "Field to read"
      }
    ]
  },
  "pluck": {
    "name": "pluck",
    "output": "array",
    "description": "Field values across an array of objects (turns [{value: 5}, ...] into [5, ...]; use before count/sum or numeric part inputs).",
    "parameters": [
      {
        "name": "field",
        "type": "string",
        "description": "Field to project"
      }
    ]
  },
  "equals": {
    "name": "equals",
    "output": "scalar",
    "description": "True when the value equals the given value.",
    "parameters": [
      {
        "name": "value",
        "type": "string",
        "description": "Value to compare"
      }
    ]
  },
  "not": {
    "name": "not",
    "output": "scalar",
    "description": "Boolean negation of the value.",
    "parameters": []
  },
  "parseNumber": {
    "name": "parseNumber",
    "output": "scalar",
    "description": "Converts input text to a number (0 when not numeric).",
    "parameters": []
  },
  "round": {
    "name": "round",
    "output": "scalar",
    "description": "Rounds a number to the given decimals.",
    "parameters": [
      {
        "name": "decimals",
        "type": "number",
        "default": 0,
        "description": "Decimal places"
      }
    ]
  },
  "format": {
    "name": "format",
    "output": "scalar",
    "description": "Inserts the value into a template at {{value}}; every other {{name}} slot fills from a same-named parameter (parameters may be live references).",
    "parameters": [
      {
        "name": "template",
        "type": "string",
        "description": "Template containing {{value}} and optional {{name}} slots"
      }
    ]
  },
  "formatNumber": {
    "name": "formatNumber",
    "output": "scalar",
    "description": "Formats a number with thousands separators and fixed decimals, optional prefix/suffix (e.g. \"$ \", \" EUR\").",
    "parameters": [
      {
        "name": "decimals",
        "type": "number",
        "default": 2,
        "description": "Decimal places"
      },
      {
        "name": "prefix",
        "type": "string",
        "default": "",
        "description": "Text before the number"
      },
      {
        "name": "suffix",
        "type": "string",
        "default": "",
        "description": "Text after the number"
      }
    ]
  },
  "formatDate": {
    "name": "formatDate",
    "output": "scalar",
    "description": "Formats a date (ISO string or epoch milliseconds) for display; style date|time|datetime|weekday.",
    "parameters": [
      {
        "name": "style",
        "type": "enum",
        "values": [
          "date",
          "time",
          "datetime",
          "weekday"
        ],
        "default": "date",
        "description": "What to show"
      }
    ]
  },
  "map": {
    "name": "map",
    "output": "any",
    "description": "Maps the value through a lookup table (mapping[String(value)]).",
    "parameters": [
      {
        "name": "mapping",
        "type": "string",
        "description": "Object of value -> replacement"
      }
    ]
  },
};
