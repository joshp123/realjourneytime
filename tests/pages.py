"""Use the site as a visitor would, on a phone and a laptop, and fail on anything broken.

Run: uv run --with playwright python tests/pages.py [http://localhost:8765] [folder for screenshots]
Each step is something a person does; each check is something they would see. Script errors, failed requests
and pages that scroll sideways fail the run.
"""
import asyncio
import re
import sys
from pathlib import Path

from playwright.async_api import async_playwright

BASE = sys.argv[1] if len(sys.argv) > 1 else "http://localhost:8765"
SHOTS = Path(sys.argv[2]) if len(sys.argv) > 2 else None
SIZES = {"laptop": (1440, 900), "phone": (390, 844)}
problems = []


class Visit:
    def __init__(self, page, size):
        self.page, self.size, self.name = page, size, ""

    async def open(self, name, address):
        self.name = name
        await self.page.goto(BASE + "/" + address, wait_until="load")
        await self.settle()

    async def settle(self):
        try:
            await self.page.wait_for_load_state("networkidle", timeout=30000)
        except Exception:
            problems.append(f"{self.name} ({self.size}): still loading after 30 s")
        await self.page.wait_for_timeout(400)

    async def see(self, selector, pattern, patience=15):
        """What a person would read there, waiting as long as a patient one would."""
        text = ""
        for _ in range(patience * 5):
            if await self.page.locator(selector).count():
                text = " ".join((await self.page.locator(selector).first.inner_text()).split())
                if re.search(pattern, text):
                    return text
            await self.page.wait_for_timeout(200)
        problems.append(f"{self.name} ({self.size}): expected /{pattern}/ in {selector}, saw: {text[:160]}")
        return text

    async def shot(self, label=None):
        if await self.page.evaluate("document.documentElement.scrollWidth > innerWidth"):
            problems.append(f"{self.name} ({self.size}): scrolls sideways")
        if SHOTS:
            await self.page.screenshot(path=str(SHOTS / f"{label or self.name}-{self.size}.png"), full_page=True)


async def journey(v):
    p = v.page
    await v.open("journey-01-front", "")
    await v.see("#title", "Amsterdam Centraal to Museumplein on weekdays")
    await v.see("#key", r"Across the day \d+ min to be sure \d+ min average \d+ min timetable \d+ min by bike")
    await v.see("#by", "All lines Tram 2 Tram 12 Tram 24")
    await v.see("#count", r"Each dot is one journey\. [\d,]+ journeys and [\d,]+ cancellations on 25\d weekdays")
    await v.shot()

    v.name = "journey-02-pointing-at-a-time"
    box = await p.locator("#chart").bounding_box()
    point = (box["x"] + box["width"] * 0.55, box["y"] + box["height"] * 0.45)
    if v.size == "phone":
        await p.touchscreen.tap(*point)
    else:
        await p.mouse.move(*point)
    await v.see("#key", r"Arriving at \d\d:\d\d")
    await v.see("#chart .tip", r"min · \w{3} \d+ \w+ 20\d\d · Tram \d+ Due to leave at \d\d:\d\d and arrive at \d\d:\d\d\. Arrived at \d\d:\d\d")
    await v.shot()
    await p.mouse.move(5, 5)

    v.name = "journey-03-bike-at-20"
    await p.locator('#speed button[data-kmh="20"]').click()
    await v.settle()
    await v.see("#key", r"\b(9|10) min by bike")
    await v.shot()

    v.name = "journey-04-from-typing"
    await p.locator("#from").click()
    await p.keyboard.type("rot")
    await v.settle()
    await v.see("#from-list", "Rotterdam Centraal")
    await v.shot()
    await p.keyboard.press("Escape")

    v.name = "journey-05-from-a-line-number"
    await p.locator("#from").click()
    await p.keyboard.type("tram 8")
    await v.settle()
    await v.see("#from-list", r"Tram 8, Rotterdam")
    await v.shot()
    await p.keyboard.press("Escape")

    v.name = "journey-06-to-list"
    await p.locator("#to").click()
    await v.settle()
    await v.see("#to-list", r"Direct from Amsterdam Centraal, busiest first .*(Sloterdijk|Utrecht)")
    await v.shot()

    v.name = "journey-07-to-no-direct-line"
    await p.keyboard.type("rijks")
    await v.settle()
    await v.see("#to-list", r"Rijksmuseum, Amsterdam No direct line .*\d+ m away")
    await v.shot()
    await p.keyboard.press("Escape")

    v.name = "journey-08-one-line"
    await p.locator("#by a", has_text="Tram 12").click()
    await v.settle()
    await v.see("#stops", r"^Stop by stop: Tram 12\.$")
    await v.shot()

    await v.open("journey-09-saturday", "?days=saturday")
    await v.see("#title", "on Saturdays")
    await v.see("#count", r"on \d\d Saturdays")
    await v.shot()

    await v.open("journey-11-train", "?from=Rotterdam+Centraal&to=Den+Haag+Centraal")
    await v.see("#by", "Intercity Metro E Sprinter")
    await v.see("#key", r"\d+ min to be sure .* 1 h \d\d by bike")
    await v.shot()

    v.name = "journey-13-few-tracked"
    await p.locator("#by a", has_text="Metro E").click()
    await v.settle()
    await v.shot()

    await v.open("journey-12-metro-a-b-c", "?from=Capelsebrug,+Rotterdam&to=Schiedam+Centrum")
    await v.see("#by", "All lines Metro A Metro B Metro C")
    await v.shot()

    await v.open("journey-14-nothing-direct", "?view=journeys&route=GVB-2&from=NL%3AQ%3A30005011&to=NL%3AQ%3A30006054&days=weekdays")
    await v.see("#chart", r"Nothing runs direct from Amsterdam Centraal to Rijksmuseum\. Nearest stops? with a direct line")
    await v.shot()
    await p.locator("#chart .msg a").first.click()
    await v.settle()
    await v.see("#key", "to be sure")

    v.name = "journey-17-methods"
    await p.locator("details.more summary").click()
    await v.see("details.more", "Trains come from the Rijden de Treinen archive, 1 Sept 2025")
    await v.shot()

    await v.open("journey-18-downloads", "")
    async with p.expect_download() as got:
        await p.locator("#download").click()
    rows = Path(await (await got.value).path()).read_text().splitlines()
    if not rows[0].startswith("date,line,due_to_leave") or len(rows) < 50000:
        problems.append(f"journey download ({v.size}): {len(rows)} rows, header {rows[0]}")
    async with p.expect_download() as got:
        await p.locator("#save").click()
    if Path(await (await got.value).path()).stat().st_size < 50000:
        problems.append(f"journey image ({v.size}): too small to be a chart")

    v.name = "journey-16-failed"
    await p.route("**/api/planner-legs*", lambda route: route.abort())
    await p.goto(BASE + "/?from=Utrecht+Centraal&to=Amsterdam+Centraal", wait_until="load")
    await p.wait_for_selector("#again", timeout=20000)
    await v.see("#chart", "This trip did not load. Try again")
    await v.shot()
    await p.unroute("**/api/planner-legs*")
    await p.locator("#again").click()
    await v.settle()
    await v.see("#key", "to be sure")


async def line(v):
    p = v.page
    await v.open("line-01-from-a-trip", "")
    await p.locator("#stops a", has_text=re.compile(r"^Tram 2$")).click()
    await v.settle()
    await v.see("#line-title", "Tram 2, Amsterdam")
    await v.see("#day-title", r"Every tram on \w+day,? \d+ \w+ 20\d\d")
    await v.see("#day-count", r"\d+ journeys in this direction, \d+ of them cancelled")
    await v.see("#slow", r"to Centraal Station .*\d min")
    await p.wait_for_function("document.getElementById('marey-canvas').width > 0")
    await v.shot("line-01-a-day")

    v.name = "line-02-one-journey"
    box = await p.locator("#marey-canvas").bounding_box()
    scroll = await p.locator("#marey-scroll").bounding_box()
    for dx in range(40, 400, 6):
        point = (scroll["x"] + dx, box["y"] + box["height"] * 0.5)
        if v.size == "phone":
            await p.touchscreen.tap(*point)
        else:
            await p.mouse.move(*point)
        if await p.locator("#marey-tip").is_visible():
            break
    else:
        problems.append(f"line ({v.size}): no journey answered a tap on the day chart")
    await v.see("#marey-tip", r"Due to leave .* at \d\d:\d\d")
    await v.shot()

    v.name = "line-03-other-direction-and-day"
    await p.locator("#line-dirs a").nth(1).click()
    await v.settle()
    before = await p.locator("#day-title").inner_text()
    await p.locator("#day-before").click()
    await v.settle()
    if await p.locator("#day-title").inner_text() == before:
        problems.append(f"line ({v.size}): the day before did not change the day")
    await v.shot()
    async with p.expect_download() as got:
        await p.locator("#day-download").click()
    rows = Path(await (await got.value).path()).read_text().splitlines()
    if rows[0] != "journey,stop,due,recorded" or len(rows) < 500:
        problems.append(f"line download ({v.size}): {len(rows)} rows, header {rows[0]}")

    await v.open("line-04-train", "?line=Intercity-1100")
    await v.see("#line-title", "Intercity")
    await v.see("#day-count", r"[1-9]\d* journeys in this direction")
    await v.shot()


async def reach(v):
    p = v.page
    await v.open("reach-01-front", "?view=reach")
    await v.see("#reach-title", "Within 30 minutes of Utrecht Centraal, leaving at 08:00 on a weekday")
    await v.see("#reach-key", r"[\d,]+ people by public transport [\d,]+ people by bike")
    await v.shot()

    v.name = "reach-02-45-minutes-bike-at-20"
    await p.locator("#within").select_option("45")
    await v.settle()
    await p.locator('#speed button[data-kmh="20"]').click()
    await v.settle()
    await v.see("#reach-title", "Within 45 minutes")
    await v.shot()

    v.name = "reach-03-map-moved-not-the-start"
    title = await p.locator("#reach-title").inner_text()
    box = await p.locator("#reach-map").bounding_box()
    cx, cy = box["x"] + box["width"] * 0.3, box["y"] + box["height"] * 0.3
    await p.mouse.dblclick(cx, cy)
    await p.mouse.move(cx, cy)
    await p.mouse.down()
    await p.mouse.move(cx + 80, cy + 40, steps=5)
    await p.mouse.up()
    await p.mouse.click(cx + 20, cy + 20)
    await p.wait_for_timeout(800)
    if await p.locator("#reach-title").inner_text() != title or await p.locator("#toast").is_visible():
        problems.append(f"reach ({v.size}): moving, zooming or clicking the map moved the start")

    await v.open("reach-03-pin-moved", "?view=reach")
    pin = await p.locator("#reach-map .pin").bounding_box()
    await p.mouse.move(pin["x"] + 13, pin["y"] + 13)
    await p.mouse.down()
    await p.mouse.move(pin["x"] + 80, pin["y"] - 10, steps=8)
    await p.mouse.up()
    await v.settle()
    await v.see("#toast", "Start moved from Utrecht Centraal. Undo")
    await v.shot()
    await p.locator("#undo").click()
    await v.settle()
    await v.see("#reach-title", "of Utrecht Centraal")

    v.name = "reach-04-choose-a-place"
    await p.locator("#reach-from").click()
    await p.keyboard.type("zwolle")
    await p.keyboard.press("Enter")
    await v.settle()
    await v.see("#reach-title", "of Zwolle")
    await v.shot()


async def bike(v):
    p = v.page
    await v.open("bike-01-front", "?view=bike")
    await v.see("#bike-title", r"The bike beats public transport on \d+% of trips")
    await v.see("#bars", r"Train [\d.]+% Metro [\d.]+% Tram \d+% Bus \d+%")
    await v.see("#wins", r"Biggest wins, one for each line Bike To be sure")
    await v.shot()

    v.name = "bike-02-at-20"
    await p.locator('#speed button[data-kmh="20"]').click()
    await v.settle()
    await v.shot()

    v.name = "bike-04-tram"
    await p.locator("#bars a", has_text="Tram").click()
    await v.settle()
    await v.see("#wins", "Biggest tram wins, one for each line · Show all")
    saves = [int(t.split()[0]) for t in await p.locator("#wins td:nth-last-child(2)").all_inner_texts()]
    if saves != sorted(saves, reverse=True) or not saves:
        problems.append(f"bike ({v.size}): the list is not in order of minutes saved: {saves}")
    await v.shot()

    await v.open("bike-05-metro-none", "?view=bike&mode=metro&kmh=15")
    await v.shot()

    await v.open("bike-06-to-the-chart", "?view=bike&mode=tram")
    await p.locator("#wins td a").first.click()
    await v.settle()
    await v.see("#key", r"to be sure .* by bike")
    await v.see("#by", "Tram")


async def main():
    if SHOTS:
        SHOTS.mkdir(parents=True, exist_ok=True)
    async with async_playwright() as play:
        browser = await play.chromium.launch()

        async def visit(size, steps):
            w, h = SIZES[size]
            context = await browser.new_context(viewport={"width": w, "height": h}, has_touch=size == "phone",
                                                device_scale_factor=2 if size == "phone" else 1, accept_downloads=True)
            page = await context.new_page()
            v = Visit(page, size)
            page.on("pageerror", lambda e: problems.append(f"{v.name} ({size}): script error: {e}"))
            page.on("console", lambda m: problems.append(f"{v.name} ({size}): console error: {m.text[:200]}")
                    if m.type == "error" and "Failed to load resource" not in m.text and v.name != "journey-16-failed" else None)
            page.on("response", lambda r: problems.append(f"{v.name} ({size}): HTTP {r.status} {r.url[:120]}")
                    if r.status >= 400 and BASE in r.url and not r.url.endswith(".json") else None)
            try:
                await steps(v)
            except Exception as error:
                problems.append(f"{v.name} ({size}): stopped: {str(error).splitlines()[0][:300]}")
                if SHOTS:
                    await page.screenshot(path=str(SHOTS / f"STOPPED-{v.name}-{size}.png"), full_page=True)
            await context.close()

        await asyncio.gather(*[visit(size, steps) for size in SIZES for steps in (journey, line, reach, bike)])
        await browser.close()
    print("\n".join(problems) if problems else "Every page worked, on a phone and a laptop.")
    sys.exit(1 if problems else 0)


asyncio.run(main())
