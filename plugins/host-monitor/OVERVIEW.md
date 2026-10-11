Shows the CPU, memory and network usage of the machine the Paseo daemon runs on, as one line in the sidebar footer.

The line reads like the built-in usage summary: an icon and percentage for CPU and RAM, with a small meter when the sidebar is wide enough, followed by download and upload speed. Meters and numbers turn yellow above 70 percent and red above 90 percent. On a narrow sidebar the network speeds are dropped first. Press the line for a popover with about three minutes of history for each metric, plus uptime and load average.

The daemon samples the host every two seconds and keeps the history in memory. History resets when the plugin reloads or the daemon restarts. Each connected host reports its own numbers.

Percentages below 10 show one decimal, so a nearly idle host reads 0.4% rather than 0%. On Linux, CPU usage comes from `/proc/stat`; I/O wait counts as idle and steal time, which a VPS loses to its hypervisor, counts as busy. Memory uses the available-memory figure from `/proc/meminfo` on Linux, so the page cache is not counted as used. Network speed sums all interfaces except loopback and common virtual ones (veth, docker, bridge). Network speed needs Linux; on other systems only CPU and RAM are shown.

The plugin only reads local system counters. It sends nothing off the host.
