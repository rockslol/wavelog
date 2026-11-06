import { createRoot } from "react-dom/client";
import { getCurrentWindow } from "@tauri-apps/api/window";
import "@fontsource/inter/400.css";
import "@fontsource/inter/500.css";
import "@fontsource/inter/600.css";
import "@fontsource/inter/700.css";
import "./style.css";
import Widget from "./Widget";
import Stats from "./Stats";
import { Calendar, Clock, Countdown, Lyrics, Note, Photos, System, TabPanel, Timer, Todo, Valorant, Weather } from "./widgets";
import Stack from "./Stack";
import Notch from "./Notch";

const VIEWS = { widget: Widget, lyrics: Lyrics, calendar: Calendar, photos: Photos, weather: Weather, system: System, clock: Clock, countdown: Countdown, todo: Todo, timer: Timer, note: Note, valorant: Valorant, tabpanel: TabPanel, stack: Stack, notch: Notch, stats: Stats };
const label = getCurrentWindow().label;
const View = VIEWS[label] || Stats;
document.documentElement.dataset.view = label === "stats" ? "stats" : "widget";
createRoot(document.getElementById("root")).render(<View />);
