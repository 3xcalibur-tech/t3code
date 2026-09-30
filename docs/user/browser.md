# Browse with your agent

Open the browser from a thread to view your project or follow your agent's browser work.
The desktop app keeps its local browser embedded in the app. When you connect to another
environment, the browser runs on that environment, so it can reach that machine's local
development servers. Web and mobile clients can watch and operate it too.

On web and desktop, click, scroll, or type directly in the page. Browser interaction pauses
agent commands briefly so they do not interfere with your input. Choose **Pause agent while
I browse** in the browser's menu to keep control during a longer task, such as signing in.
Turn it off when you finish. The device toolbar lets you choose a device preset or resize
the viewport. On mobile, choose **Take control** and then **Return to agent** when finished.
Other connected clients can watch while you control the page. Disconnecting the viewer
returns control without closing the browser tab.

The first browser opened on an environment without a desktop app downloads its browser
runtime. This requires npm, internet access, and the system libraries needed by Chromium.
Later tabs reuse that installation. Signed-in sessions stay on the environment that owns
the browser; they are not copied to the device watching it.

Agent browser access is controlled in **Settings → Integrations → Browser** and can also
be overridden for a project. Access changes apply when the agent session next starts.
Agents can use the managed `agent-browser` command to inspect pages and operate the same
tab you see. It respects human control and the thread's selected browser tab.

Local desktop profiles can [import signed-in browser sessions](./browser-import.md).
