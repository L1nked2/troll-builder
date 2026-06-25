import urllib.parse
import argparse
import copy
import html as html_utils
import json
import time
import sys
import os
import re
from datetime import datetime, timedelta, timezone

try:
    import requests
except ModuleNotFoundError:
    requests = None

# Configure standard output to use UTF-8 to prevent console encoding issues in Windows
sys.stdout.reconfigure(encoding='utf-8')

HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    "Referer": "https://www.deeplol.gg/",
    "Accept": "application/json, text/plain, */*"
}

DEFAULT_VERSION = "16.12.1"

def require_requests():
    if requests is None:
        print("Error: Python package 'requests' is required for crawling.")
        print("Install it with: pip install -r requirements.txt")
        sys.exit(1)

def normalize_key(riot_id_name, riot_id_tag_line):
    return (
        (riot_id_name or "").strip().casefold(),
        (riot_id_tag_line or "KR1").strip().casefold()
    )

def parse_player_ref(value):
    if "#" in value:
        name, tag = value.rsplit("#", 1)
    else:
        name, tag = value, "KR1"
    return normalize_key(name, tag)

def now_utc_iso():
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat()

def parse_utc_iso(value):
    if not value:
        return None
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None

def make_placeholder(entry):
    placeholder = {
        "riot_id_name": entry.get("riot_id_name"),
        "riot_id_tag_line": entry.get("riot_id_tag_line", "KR1"),
        "position": entry.get("position", ""),
        "puu_id": None,
        "level": 0,
        "profile_icon_id": 1,
        "tier_info": {
            "solo": {"tier": "UNRANKED", "division": 0, "lp": 0, "wins": 0, "losses": 0, "win_rate": 0},
            "flex": {"tier": "UNRANKED", "division": 0, "lp": 0, "wins": 0, "losses": 0, "win_rate": 0}
        },
        "top_champions": [],
        "recent_matches": [],
        "season_history": [],
        "solo_lp_graph": None,
        "flex_lp_graph": None,
        "updated_at": now_utc_iso()
    }
    if "initial_budget" in entry:
        placeholder["initial_budget"] = entry["initial_budget"]
    return placeholder

def load_existing_data(output_path):
    if not os.path.exists(output_path):
        return {}
    try:
        with open(output_path, "r", encoding="utf-8") as f:
            return json.load(f)
    except (json.JSONDecodeError, OSError) as e:
        print(f"Warning: failed to read existing cache ({e}). A new file will be built.")
        return {}

def build_cache(existing_data):
    cache = {}
    for section in ("captains", "players"):
        for player in existing_data.get(section, []):
            key = normalize_key(player.get("riot_id_name"), player.get("riot_id_tag_line"))
            if key[0]:
                cache[key] = player
    return cache

def is_cache_stale(player, max_age_hours):
    if max_age_hours is None:
        return False
    updated_at = parse_utc_iso(player.get("updated_at"))
    if updated_at is None:
        return False
    return datetime.now(timezone.utc) - updated_at > timedelta(hours=max_age_hours)

def with_input_position(player, entry):
    copied = copy.deepcopy(player)
    copied["position"] = entry.get("position", "")
    copied["riot_id_name"] = copied.get("riot_id_name") or entry.get("riot_id_name")
    copied["riot_id_tag_line"] = copied.get("riot_id_tag_line") or entry.get("riot_id_tag_line", "KR1")
    if "initial_budget" in entry:
        copied["initial_budget"] = entry["initial_budget"]
    elif "initial_budget" in copied:
        del copied["initial_budget"]
    return copied

def build_arg_parser():
    parser = argparse.ArgumentParser(description="Build players_data.json for the auction app.")
    parser.add_argument("--refresh", action="store_true", help="Ignore cache and crawl every configured player.")
    parser.add_argument(
        "--refresh-player",
        action="append",
        default=[],
        metavar="NAME#TAG",
        help="Refresh only one player. Can be passed multiple times."
    )
    parser.add_argument(
        "--max-age-hours",
        type=float,
        default=None,
        help="Refresh cached rows older than this many hours. Omit to never expire cached rows automatically."
    )
    parser.add_argument("--offline", action="store_true", help="Do not call external APIs; only rebuild from cache/input.")
    parser.add_argument("--skip-fow", action="store_true", help="Skip Fow.lol season and LP graph requests for refreshed players.")
    return parser

def get_latest_version():
    require_requests()
    url = "https://ddragon.leagueoflegends.com/api/versions.json"
    try:
        print("Fetching latest game version from DDragon...")
        resp = requests.get(url, timeout=10)
        if resp.status_code == 200:
            versions = resp.json()
            if versions and len(versions) > 0:
                version = versions[0]
                print(f"Latest version found: {version}")
                return version
    except Exception as e:
        print(f"Error fetching version: {e}. Defaulting to {DEFAULT_VERSION}")
    return DEFAULT_VERSION

def get_champion_mapping(version):
    require_requests()
    deeplol_ver = ".".join(version.split(".")[:2])
    url = f"https://b2c-api-cdn.deeplol.gg/common/champion-info?version={deeplol_ver}"
    mapping = {}
    try:
        print(f"Fetching champion mapping for version {deeplol_ver}...")
        resp = requests.get(url, headers=HEADERS, timeout=10)
        if resp.status_code == 200:
            champs = resp.json()
            if isinstance(champs, dict):
                champ_list = champs.get("champions", [])
            elif isinstance(champs, list):
                champ_list = champs
            else:
                champ_list = []
                
            for champ in champ_list:
                champ_id = str(champ.get("champion_id"))
                mapping[champ_id] = {
                    "name_en": champ.get("champion_name_en"),
                    "name_kr": champ.get("champion_name_kr"),
                    "image": champ.get("image_name")
                }
            print(f"Loaded {len(mapping)} champions from metadata.")
    except Exception as e:
        print(f"Error loading champion mapping: {e}")
    return mapping

def fetch_player_data(riot_id_name, riot_id_tag_line, champ_mapping):
    require_requests()
    encoded_name = urllib.parse.quote(urllib.parse.quote(riot_id_name))
    url = f"https://b2c-api-cdn.deeplol.gg/summoner/summoner?riot_id_name={encoded_name}&riot_id_tag_line={riot_id_tag_line}&platform_id=KR"
    
    print(f"Fetching profile for {riot_id_name}#{riot_id_tag_line}...")
    try:
        resp = requests.get(url, headers=HEADERS, timeout=10)
        if resp.status_code != 200:
            print(f"  Failed to fetch summoner (Status: {resp.status_code})")
            return None
        
        data = resp.json()
        basic_info = data.get("summoner_basic_info_dict")
        if not basic_info:
            print(f"  Summoner basic info not found for {riot_id_name}#{riot_id_tag_line}")
            return None
            
        puu_id = basic_info.get("puu_id")
        level = basic_info.get("level")
        profile_icon_id = basic_info.get("profile_id")
        official_name = basic_info.get("riot_id_name", riot_id_name)
        official_tag = basic_info.get("riot_id_tag_line", riot_id_tag_line)
        
        player_stats = {
            "riot_id_name": official_name,
            "riot_id_tag_line": official_tag,
            "puu_id": puu_id,
            "level": level,
            "profile_icon_id": profile_icon_id,
            "tier_info": {},
            "top_champions": [],
            "recent_matches": []
        }
        
        if not puu_id:
            return player_stats
            
        # 1. Fetch Realtime/Tier Info
        time.sleep(0.5)
        realtime_url = f"https://b2c-api-cdn.deeplol.gg/summoner/summoner-realtime?platform_id=KR&summoner_id=&puu_id={puu_id}"
        rt_resp = requests.get(realtime_url, headers=HEADERS, timeout=10)
        if rt_resp.status_code == 200:
            rt_data = rt_resp.json()
            tier_dict = rt_data.get("season_tier_info_dict", {})
            
            for queue_key, queue_name in [("ranked_solo_5x5", "solo"), ("ranked_flex_sr", "flex")]:
                q_info = tier_dict.get(queue_key)
                if q_info:
                    player_stats["tier_info"][queue_name] = {
                        "tier": q_info.get("tier", "UNRANKED"),
                        "division": q_info.get("division", 0),
                        "lp": q_info.get("league_points", 0),
                        "wins": q_info.get("wins", 0),
                        "losses": q_info.get("losses", 0),
                        "win_rate": round(q_info.get("wins", 0) / (q_info.get("wins", 0) + q_info.get("losses", 1)) * 100, 1) if (q_info.get("wins", 0) + q_info.get("losses", 0)) > 0 else 0
                    }
                else:
                    player_stats["tier_info"][queue_name] = {
                        "tier": "UNRANKED",
                        "division": 0,
                        "lp": 0,
                        "wins": 0,
                        "losses": 0,
                        "win_rate": 0
                    }
        
        # 2. Fetch Champion Stats
        time.sleep(0.5)
        champ_url = f"https://b2c-api-cdn.deeplol.gg/summoner/champion-stat?puu_id={puu_id}&season=27&platform_id=KR"
        champ_resp = requests.get(champ_url, headers=HEADERS, timeout=10)
        print(f"  Champion stats status: {champ_resp.status_code}")
        if champ_resp.status_code == 200:
            champ_data = champ_resp.json()
            # Extract player stats from counter_champion_stats -> total -> enemy_champion_stats -> All
            enemy_stats = champ_data.get("counter_champion_stats", {}).get("total", {}).get("enemy_champion_stats", {})
            champ_list = enemy_stats.get("All", [])
            print(f"  Found {len(champ_list)} champion stats.")
            
            # Sort by games played descending
            sorted_champs = sorted(champ_list, key=lambda c: c.get("games", 0), reverse=True)
            for c in sorted_champs:
                cid = str(c.get("champion_id"))
                if cid == "0":
                    continue
                    
                meta = champ_mapping.get(cid, {"name_kr": f"Unknown ({cid})", "name_en": "Unknown", "image": "default.png"})
                
                player_stats["top_champions"].append({
                    "champion_id": cid,
                    "name_kr": meta["name_kr"],
                    "name_en": meta["name_en"],
                    "image": meta["image"],
                    "games": c.get("games", 0),
                    "win_rate": round(c.get("win_rate", 0.0), 1),
                    "kda": round(c.get("kda", 0.0), 2),
                    "kills": round(c.get("kills", 0.0), 1),
                    "deaths": round(c.get("deaths", 0.0), 1),
                    "assists": round(c.get("assists", 0.0), 1)
                })
                if len(player_stats["top_champions"]) >= 10:
                    break
                
        # 3. Fetch Recent Matches (with only_list=0 to get full details)
        time.sleep(0.5)
        match_url = f"https://b2c-api-cdn.deeplol.gg/match/matches?puu_id={puu_id}&platform_id=KR&offset=0&count=10&queue_type=ALL&champion_id=0&only_list=0&last_updated_at=0"
        match_resp = requests.get(match_url, headers=HEADERS, timeout=10)
        print(f"  Match history status: {match_resp.status_code}")
        if match_resp.status_code == 200:
            match_data = match_resp.json()
            matches = match_data.get("match_json_list", [])
            print(f"  Found {len(matches)} matches.")
            
            # Queue ID mapping helper
            queue_map = {
                420: "솔로랭크",
                440: "자유랭크",
                450: "칼바람나락",
                430: "일반",
                1900: "우르프",
                1700: "아레나"
            }
            
            for m in matches[:10]:
                basic = m.get("match_basic_dict", {})
                parts = m.get("participants_list", [])
                
                # Find our participant details
                our_part = None
                for p in parts:
                    if p.get("puu_id") == puu_id:
                        our_part = p
                        break
                        
                if not our_part:
                    continue
                    
                cid = str(our_part.get("champion_id"))
                meta = champ_mapping.get(cid, {"name_kr": f"Unknown ({cid})", "name_en": "Unknown", "image": "default.png"})
                
                final_stats = our_part.get("final_stat_dict", {})
                
                # Timestamp parsing
                timestamp = basic.get("creation_timestamp", 0)
                # If timestamp is in seconds, convert to milliseconds for JS Date object
                if timestamp < 1e11:
                    timestamp = int(timestamp * 1000)
                
                queue_id = basic.get("queue_id", 0)
                queue_type_name = queue_map.get(queue_id, "일반")
                
                player_stats["recent_matches"].append({
                    "win": our_part.get("is_win", False),
                    "queue_type": queue_type_name,
                    "champion_name_kr": meta["name_kr"],
                    "champion_name_en": meta["name_en"],
                    "champion_image": meta["image"],
                    "kills": final_stats.get("kills", 0),
                    "deaths": final_stats.get("deaths", 0),
                    "assists": final_stats.get("assists", 0),
                    "duration": basic.get("game_duration", 0),
                    "timestamp": timestamp
                })
                
        return player_stats
        
    except Exception as e:
        print(f"  Error fetching data for {riot_id_name}: {e}")
        import traceback
        traceback.print_exc()
        return None

def fetch_fow_data(riot_id_name, riot_id_tag_line):
    require_requests()
    path = f"{riot_id_name}-{riot_id_tag_line}"
    encoded_path = urllib.parse.quote(path)
    url = f"https://www.fow.lol/find/kr/{encoded_path}"
    
    headers = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
        "Accept-Language": "ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7",
    }
    
    fow_data = {
        "season_history": [],
        "solo_lp_graph": None,
        "flex_lp_graph": None
    }
    
    print(f"  Fetching Fow.lol profile for {riot_id_name}#{riot_id_tag_line}...")
    try:
        resp = requests.get(url, headers=headers, timeout=10)
        if resp.status_code != 200:
            print(f"    Failed to fetch Fow.lol page (Status: {resp.status_code})")
            return fow_data
            
        html = resp.text
        
        # 1. Parse sid
        sid_match = re.search(r"data-sid=['\"](\d+)['\"]", html)
        if not sid_match:
            print("    data-sid not found on Fow.lol page")
            return fow_data
            
        sid = sid_match.group(1)
        
        # 2. Parse Season History
        # Fow stores season badges in DIVs whose tipsy attribute contains HTML-like <BR> text.
        # Parsing by generic tag attributes breaks on those <BR> tokens, so read tipsy attrs directly.
        season_history = []
        seen_seasons = set()
        for tipsy_match in re.finditer(r"\btipsy=(['\"])(.*?)\1", html, flags=re.IGNORECASE | re.DOTALL):
            tipsy_val = html_utils.unescape(tipsy_match.group(2))
            if "최종 기록" not in tipsy_val and "Final record" not in tipsy_val:
                continue

            after_attr = html[tipsy_match.end():tipsy_match.end() + 500]
            tag_end = after_attr.find(">")
            div_end = after_attr.find("</DIV>")
            a_end = after_attr.find("</A>")
            close_candidates = [idx for idx in (div_end, a_end) if idx != -1]
            close_idx = min(close_candidates) if close_candidates else -1
            if tag_end == -1 or close_idx == -1 or tag_end > close_idx:
                continue

            text = re.sub(r"<[^>]+>", "", after_attr[tag_end + 1:close_idx])
            text = html_utils.unescape(text).strip()
            if not text or not re.match(r"^S\d+", text):
                continue

            if text in seen_seasons:
                continue
            seen_seasons.add(text)
            season_history.append({
                "season": text,
                "tipsy": tipsy_val
            })
        fow_data["season_history"] = season_history
        print(f"    Loaded {len(season_history)} season records.")
        
        # 3. Parse Solo and Flex Graphs
        for q_key, queue in [("solo_lp_graph", "RANKED_SOLO_5x5"), ("flex_lp_graph", "RANKED_FLEX_SR")]:
            time.sleep(0.5) # rate limit
            graph_url = f"https://www.fow.lol/api/leaguegraph?sid={sid}&region=kr&queue={queue}&mode=day"
            g_resp = requests.get(graph_url, headers=headers, timeout=10)
            if g_resp.status_code == 200:
                graph_js = g_resp.text
                
                # Parse categories (labels)
                categories_match = re.search(r"categories:\s*(\[[^\]]*\])", graph_js)
                categories = []
                if categories_match:
                    cat_content = categories_match.group(1)
                    categories = re.findall(r"['\"]([^'\"]+)['\"]", cat_content)
                
                # Parse data points
                data_match = re.search(r"data:\s*(\[[^\]]*\])", graph_js)
                data_points = []
                if data_match:
                    data_content = data_match.group(1)
                    points = re.findall(r"\{([^\}]+)\}", data_content)
                    for pt in points:
                        y_match = re.search(r"y\s*:\s*(-?\d+|null)", pt)
                        name_match = re.search(r"name\s*:\s*['\"]([^'\"]+)['\"]", pt)
                        
                        y_val = None
                        if y_match:
                            val_str = y_match.group(1)
                            if val_str != "null":
                                y_val = int(val_str)
                        
                        name_val = name_match.group(1) if name_match else ""
                        data_points.append({"y": y_val, "name": name_val})
                
                if categories and data_points:
                    fow_data[q_key] = {
                        "labels": categories,
                        "data": data_points
                    }
                    print(f"    Loaded {len(data_points)} points for {q_key}.")
            else:
                print(f"    Failed to fetch {queue} graph (Status: {g_resp.status_code})")
                
    except Exception as e:
        print(f"    Error fetching Fow.lol data: {e}")
        
    return fow_data

def refresh_entry(entry, champ_mapping, skip_fow):
    name = entry.get("riot_id_name")
    tag = entry.get("riot_id_tag_line", "KR1")
    data = fetch_player_data(name, tag, champ_mapping)
    if not data:
        return None

    if not skip_fow:
        fow_info = fetch_fow_data(name, tag)
        data.update(fow_info)

    data["position"] = entry.get("position", "")
    if "initial_budget" in entry:
        data["initial_budget"] = entry["initial_budget"]
    data["updated_at"] = now_utc_iso()
    return data

def should_refresh_entry(entry, cached, args, refresh_keys):
    key = normalize_key(entry.get("riot_id_name"), entry.get("riot_id_tag_line", "KR1"))
    if args.offline:
        return False
    if args.refresh or key in refresh_keys:
        return True
    if cached is None:
        return True
    return is_cache_stale(cached, args.max_age_hours)

def build_section(section_name, entries, cache, args, refresh_keys, champ_mapping):
    section_data = []
    print(f"\n--- Building {section_name.capitalize()} ---")

    for entry in entries:
        name = entry.get("riot_id_name")
        tag = entry.get("riot_id_tag_line", "KR1")
        key = normalize_key(name, tag)
        cached = cache.get(key)

        if should_refresh_entry(entry, cached, args, refresh_keys):
            print(f"Refreshing {name}#{tag}...")
            data = refresh_entry(entry, champ_mapping, args.skip_fow)
            if data:
                section_data.append(data)
            elif cached:
                print(f"  Refresh failed. Reusing cached data for {name}#{tag}.")
                section_data.append(with_input_position(cached, entry))
            else:
                print(f"  Refresh failed and no cache exists. Using placeholder for {name}#{tag}.")
                section_data.append(make_placeholder(entry))
            time.sleep(1)
        elif cached:
            print(f"Using cached data for {name}#{tag}.")
            section_data.append(with_input_position(cached, entry))
        else:
            print(f"No cached data for {name}#{tag}. Using placeholder.")
            section_data.append(make_placeholder(entry))

    return section_data

def main():
    args = build_arg_parser().parse_args()
    script_dir = os.path.dirname(os.path.abspath(__file__))
    input_path = os.path.join(script_dir, "players_input.json")
    output_path = os.path.join(script_dir, "players_data.json")
    
    try:
        with open(input_path, "r", encoding="utf-8") as f:
            config = json.load(f)
    except FileNotFoundError:
        print(f"Error: {input_path} not found.")
        return
        
    initial_budget = config.get("initial_budget", 1000)
    existing_data = load_existing_data(output_path)
    cache = build_cache(existing_data)
    refresh_keys = {parse_player_ref(ref) for ref in args.refresh_player}

    all_entries = config.get("captains", []) + config.get("players", [])
    needs_fetch = any(
        should_refresh_entry(
            entry,
            cache.get(normalize_key(entry.get("riot_id_name"), entry.get("riot_id_tag_line", "KR1"))),
            args,
            refresh_keys
        )
        for entry in all_entries
    )

    version = existing_data.get("version", DEFAULT_VERSION)
    champ_mapping = {}
    if needs_fetch:
        version = get_latest_version()
        champ_mapping = get_champion_mapping(version)
    elif args.offline:
        print("Offline mode enabled. External API calls will be skipped.")
    else:
        print("All configured players are available in cache. No external API calls needed.")

    captains_data = build_section("captains", config.get("captains", []), cache, args, refresh_keys, champ_mapping)
    players_data = build_section("players", config.get("players", []), cache, args, refresh_keys, champ_mapping)
        
    output = {
        "captains": captains_data,
        "players": players_data,
        "version": version,
        "initial_budget": initial_budget,
        "generated_at": now_utc_iso()
    }
    
    with open(output_path, "w", encoding="utf-8") as f:
        json.dump(output, f, indent=2, ensure_ascii=False)
        
    print("\nDone! Data build completed successfully.")
    print(f"Consolidated data saved to {output_path}.")


if __name__ == "__main__":
    main()
