# Dynamic Experience Runtime (DER)

A system that enables the creation of dynamic, interactive user experiences through AI-generated contracts. The system transforms high-level blueprints into structured contracts, which are then rendered as interactive experiences by the runtime.

## Project Structure

```
src/
├── types/                    # Core TypeScript type definitions
│   ├── blueprint.ts         # Blueprint and natural language processing types
│   ├── contract.ts          # Contract and UI element types
│   ├── experience.ts        # Runtime experience and operation types
│   ├── component.ts         # Component manifest types
│   ├── repository.ts        # Repository and component discovery types
│   ├── persistence.ts       # Bookmarking and sharing types
│   └── index.ts            # Type exports
├── interfaces/              # System component interfaces
│   ├── ai-interpreter.ts    # AI processing interfaces
│   ├── contract-builder.ts  # Contract generation interfaces
│   ├── dynamic-runtime.ts   # Experience rendering interfaces
│   ├── experience-editor.ts # Manual editing interfaces
│   ├── error-handling.ts    # Error management interfaces
│   └── index.ts            # Interface exports
├── components/              # React components (to be implemented)
│   ├── ui/                 # UI components
│   ├── runtime/            # Runtime components
│   ├── editor/             # Editor components
│   └── index.ts
├── services/               # Service layer (to be implemented)
│   ├── ai-interpreter/     # AI processing service
│   ├── contract-builder/   # Contract generation service
│   ├── repository/         # Component repository service
│   ├── persistence/        # Persistence service
│   └── index.ts
├── utils/                  # Utility functions (to be implemented)
│   ├── validation.ts       # Schema validation utilities
│   ├── serialization.ts    # Data serialization utilities
│   ├── error-handling.ts   # Error handling utilities
│   └── index.ts
└── test/                   # Test setup and utilities
    └── setup.ts
```

## Technology Stack

- **Frontend**: React 18+ with TypeScript
- **Backend**: Rust with Tauri for native desktop capabilities
- **State Management**: Zustand (planned)
- **Validation**: Zod and AJV for schema validation
- **Testing**: Vitest with React Testing Library
- **Build Tool**: Vite
- **Linting**: ESLint with TypeScript support
- **Formatting**: Prettier

## Development Scripts

```bash
# Development
npm run dev              # Start development server
npm run tauri dev        # Start Tauri development mode

# Building
npm run build            # Build for production
npm run tauri build      # Build Tauri application

# Code Quality
npm run lint             # Run ESLint
npm run lint:fix         # Fix ESLint issues
npm run format           # Format code with Prettier
npm run format:check     # Check code formatting
npm run type-check       # Run TypeScript type checking

# Testing
npm run test             # Run tests
npm run test:watch       # Run tests in watch mode
npm run test:ui          # Run tests with UI
```

## Core Concepts

### Blueprint
Natural language descriptions transformed into structured JSON format that defines the desired application behavior.

### Contract
Structured specifications that define UI elements, operations, and their bindings. Generated from blueprints and used by the runtime to render experiences.

### Experience
The rendered, interactive application created from a contract. Includes React components, state management, and operation execution.

### Component Repository
A system for storing and discovering UI elements and operations with their manifests, enabling dynamic composition.

### Dynamic Experience Runtime (DER)
The core system that renders contracts into interactive React experiences with real-time updates.

## Requirements Coverage

This project structure addresses all requirements from the specification:

- **Requirements 1.1, 2.1, 3.1**: Core interfaces and types defined
- **Requirements 6.1, 6.2, 7.1, 7.2**: Component repository types and interfaces
- **Requirements 4.1-4.5**: Persistence and sharing types
- **Requirements 5.1-5.6, 10.2-10.7**: Experience editor interfaces
- **Requirements 8.1-8.5, 9.5**: Comprehensive error handling interfaces

## Next Steps

The project structure and core interfaces are now complete. The next tasks will involve:

1. Implementing data models and validation (Task 2)
2. Creating the AI Interpreter (Task 3)
3. Building the Component Repository (Task 4)
4. Implementing the Dynamic Experience Runtime (Task 5)
5. Creating the Experience Editor (Task 6)
6. Building the Persistence Layer (Task 7)
7. Adding comprehensive error handling (Task 8)
8. Creating tests (Task 9)
9. Final integration (Task 10)