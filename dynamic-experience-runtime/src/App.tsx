import { useState } from "react";
import reactLogo from "./assets/react.svg";
import { invoke } from "@tauri-apps/api/core";
import "./App.css";
import { Blueprint } from "@/types";

function App() {
  const [greetMsg, setGreetMsg] = useState("");
  const [name, setName] = useState("");

  async function greet() {
    // Learn more about Tauri commands at https://tauri.app/develop/calling-rust/
    setGreetMsg(await invoke("greet", { name }));
  }

  // Example usage of our types to verify they're working
  const exampleBlueprint: Blueprint = {
    description: "A simple counter application",
    goal: "Create an interactive counter",
    requiredCapabilities: ["button", "display"],
    uiElements: [
      {
        type: "button",
        purpose: "Increment counter",
        capabilities: ["click"]
      },
      {
        type: "display",
        purpose: "Show counter value",
        capabilities: ["text-display"]
      }
    ],
    operations: [
      {
        name: "increment",
        purpose: "Increase counter by 1",
        inputs: ["current-value"],
        outputs: ["new-value"],
        executionType: "local"
      }
    ],
    ambiguities: []
  };

  return (
    <main className="container">
      <h1>Dynamic Experience Runtime</h1>

      <div className="row">
        <a href="https://vite.dev" target="_blank">
          <img src="/vite.svg" className="logo vite" alt="Vite logo" />
        </a>
        <a href="https://tauri.app" target="_blank">
          <img src="/tauri.svg" className="logo tauri" alt="Tauri logo" />
        </a>
        <a href="https://react.dev" target="_blank">
          <img src={reactLogo} className="logo react" alt="React logo" />
        </a>
      </div>
      <p>Project structure and core interfaces are set up!</p>

      <form
        className="row"
        onSubmit={(e) => {
          e.preventDefault();
          greet();
        }}
      >
        <input
          id="greet-input"
          onChange={(e) => setName(e.currentTarget.value)}
          placeholder="Enter a name..."
        />
        <button type="submit">Greet</button>
      </form>
      <p>{greetMsg}</p>
      
      <details style={{ marginTop: '20px', textAlign: 'left' }}>
        <summary>Example Blueprint (click to expand)</summary>
        <pre style={{ fontSize: '12px', overflow: 'auto' }}>
          {JSON.stringify(exampleBlueprint, null, 2)}
        </pre>
      </details>
    </main>
  );
}

export default App;
