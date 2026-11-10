#!/usr/bin/env python3
"""Validate the authoring contract of an Axonkey photo-derived SVG draft."""

import argparse
from collections import Counter
import math
from pathlib import Path
import re
import sys
import xml.etree.ElementTree as ET

SVG = "http://www.w3.org/2000/svg"
AK = "urn:axonkey:device:1"
SCHEMA = "axonkey.device/1"
FORBIDDEN_TAGS = {"script", "foreignObject", "image", "iframe", "object", "embed"}
RUNTIME_TAGS = {"source", "report", "reports", "voice", "identity", "match"}
RUNTIME_ATTRIBUTES = {"report", "page", "usage", "engine", "field", "equals", "legacy-key"}


def validate(path):
    source = path.read_text(encoding="utf-8-sig")
    validate_source(source)
    root = ET.fromstring(source)
    require(root.tag == f"{{{SVG}}}svg", "expected SVG namespace and root")
    require(root.get("data-ak-status") == "draft", "root must declare data-ak-status=draft")
    view_box = numbers(root.get("viewBox", ""), 4, "viewBox")
    min_x, min_y, width, height = view_box
    require(width > 0 and height > 0, "viewBox needs positive width and height")
    devices = root.findall(f"./{{{SVG}}}metadata/{{{AK}}}device")
    require(len(devices) == 1, "expected one metadata ak:device")
    device = devices[0]
    require(device.get("status") == "draft", "ak:device must declare status=draft")
    for root_name, device_name in (
        ("data-ak-schema", "schema"),
        ("data-ak-device", "id"),
        ("data-ak-revision", "revision"),
    ):
        value = root.get(root_name)
        require(value and value == device.get(device_name), f"conflicting or absent {root_name}")
    require(device.get("schema") == SCHEMA, "draft must use the v1 artwork contract")
    require(device.get("revision", "").isdigit() and int(device.get("revision")) > 0,
            "revision must be a positive integer")
    ids = collect_ids(root)
    inputs = device.findall(f"./{{{AK}}}inputs/{{{AK}}}input")
    require(inputs, "draft has no inputs")
    input_ids = set()
    for node in inputs:
        validate_input(node, ids)
        key = node.get("id")
        require(key not in input_ids, f"duplicate input {key}")
        input_ids.add(key)
    regions = {}
    graphics = set()
    parents = {child: parent for parent in root.iter() for child in parent}
    counts = Counter()
    for node in root.iter():
        validate_node(node)
        key = node.get("data-ak-key")
        if key is not None:
            require(key in input_ids, f"graphic references unknown input {key}")
            require(node.get("data-ak-role") == "input", f"graphic {key} needs data-ak-role=input")
            require(node.get("aria-label", "").strip(), f"graphic {key} needs an accessible label")
            require(node.get("role") == "button", f"graphic {key} needs role=button")
            require(node.get("tabindex") == "0", f"graphic {key} needs tabindex=0")
            graphics.add(key)
        region = node.get("data-ak-region")
        if region is not None:
            require(node.tag == f"{{{SVG}}}path" and node.get("d", "").strip(),
                    f"region {region} needs an SVG path")
            require(region not in regions, f"duplicate region {region}")
            x, y = numbers(node.get("data-ak-anchor", ""), 2, f"anchor {region}")
            require(min_x <= x <= min_x + width and min_y <= y <= min_y + height,
                    f"anchor {region} is outside viewBox")
            regions[region] = node
    require(set(regions) == input_ids, "input/region IDs must match one to one")
    require(graphics == input_ids, "input/graphic IDs must match")
    for node in inputs:
        target = ids[node.get("target")[1:]]
        require(target.get("data-ak-key") == node.get("id"),
                f"target for {node.get('id')} must carry its data-ak-key")
        counts[view_of(target, parents)] += 1
    return f"{path}: {len(inputs)} pending inputs; " + ", ".join(
        f"{view}={count}" for view, count in sorted(counts.items())
    )


def validate_source(source):
    require(not re.search(r"<!\s*(DOCTYPE|ENTITY)\b", source, re.I),
            "DOCTYPE and entity declarations are not allowed")


def collect_ids(root):
    ids = {}
    for node in root.iter():
        value = node.get("id")
        if value is not None:
            require(value and value not in ids, f"duplicate or empty XML id {value}")
            ids[value] = node
    return ids


def validate_input(node, ids):
    for name in ("id", "label", "short", "icon", "kind", "order", "target"):
        require(node.get(name, "").strip(), f"input needs {name}")
    key = node.get("id")
    require(node.get("binding") == "pending", f"input {key} must be binding=pending")
    require(node.get("original") == "false", f"input {key} must be original=false")
    require(not (RUNTIME_ATTRIBUTES & node.attrib.keys()), f"input {key} contains runtime binding fields")
    target = node.get("target")
    require(target.startswith("#") and target[1:] in ids, f"input {key} has a missing target")
    require(re.fullmatch(r"\d+", node.get("order")), f"input {key} needs a nonnegative integer order")


def validate_node(node):
    namespace, _, local = node.tag[1:].partition("}") if node.tag.startswith("{") else ("", "", node.tag)
    require(local not in FORBIDDEN_TAGS, f"{local} is not allowed in a vector draft")
    require(not (namespace == AK and local in RUNTIME_TAGS), f"ak:{local} belongs to runtime integration")
    require(namespace in {SVG, AK}, f"unexpected namespace on {local}")
    for name, value in node.attrib.items():
        attribute = name.rsplit("}", 1)[-1]
        require(not attribute.lower().startswith("on"), f"event attribute {attribute} is not allowed")
        if attribute == "href":
            require(value.startswith("#") and len(value) > 1, "only local SVG references are allowed")
        for reference in re.findall(r"url\(\s*['\"]?([^)'\"]+)", value, re.I):
            require(reference.startswith("#"), "external CSS resources are not allowed")
    if local == "style":
        style = "".join(node.itertext())
        require(not re.search(r"@import|url\(", style, re.I), "style resources are not allowed in drafts")


def numbers(value, count, label):
    try:
        result = [float(part) for part in re.split(r"[\s,]+", value.strip()) if part]
    except ValueError as error:
        raise ValueError(f"invalid {label}") from error
    require(len(result) == count and all(math.isfinite(number) for number in result),
            f"{label} needs {count} finite numbers")
    return result


def view_of(node, parents):
    while node is not None:
        if node.get("data-ak-view"):
            return node.get("data-ak-view")
        node = parents.get(node)
    return "unspecified-view"


def require(condition, message):
    if not condition:
        raise ValueError(message)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("svg", type=Path)
    args = parser.parse_args()
    try:
        print(validate(args.svg))
    except (OSError, ET.ParseError, ValueError) as error:
        print(f"Invalid draft: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
