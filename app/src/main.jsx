import { Component } from "react";
import { createRoot } from "react-dom/client";
import { getCurrentWindow } from "@tauri-apps/api/window";
import "@fontsource/inter/400.css";
import "@fontsource/inter/500.css";
import "@fontsource/inter/600.css";
import "@fontsource/inter/700.css";
import "./style.css";
import Widget from "./Widget";
import Stats from "./Stats";
import { Calendar, Clock, Countdown, Lyrics, Note, Photos, System, TabPanel, Timer, Todo, Valorant, Visualizer, Weather } from "./widgets";
import Stack from "./Stack";
import Notch from "./Notch";
import { PluginOverlay, PluginWidget } from "./Plugins";

const VIEWS = { widget: Widget, lyrics: Lyrics, calendar: Calendar, photos: Photos, weather: Weather, system: System, clock: Clock, countdown: Countdown, todo: Todo, timer: Timer, note: Note, valorant: Valorant, viz: Visualizer, tabpanel: TabPanel, stack: Stack, notch: Notch, stats: Stats };
const label = getCurrentWindow().label;
const View = VIEWS[label] || (label.startsWith("po_") ? PluginOverlay : label.startsWith("p_") ? PluginWidget : Stats);
document.documentElement.dataset.view = label === "stats" ? "stats" : "widget";

// If the stats window ever crashes, show what happened and a way back instead of a black window.
class Boundary extends Component {
  state = { error: null };
  static getDerivedStateFromError(error) {
    return { error };
  }
  render() {
    const e = this.state.error;
    if (!e) return this.props.children;
    return (
      <div className="crash">
        <b>Something went wrong</b>
        <code>{String(e?.message || e)}</code>
        <button className="pill glass" onClick={() => location.reload()}>Reload</button>
      </div>
    );
  }
}

createRoot(document.getElementById("root")).render(label === "stats" ? <Boundary><View /></Boundary> : <View />);
