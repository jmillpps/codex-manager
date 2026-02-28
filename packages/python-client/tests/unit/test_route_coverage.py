from __future__ import annotations

import ast
import json
import re
from pathlib import Path


def _repo_root() -> Path:
    # packages/python-client/tests/unit -> repo root
    return Path(__file__).resolve().parents[4]


def _client_routes() -> set[tuple[str, str]]:
    api_path = _repo_root() / "packages" / "python-client" / "src" / "codex_manager" / "api.py"
    source = api_path.read_text(encoding="utf-8")
    tree = ast.parse(source)

    routes: set[tuple[str, str]] = set()

    class Visitor(ast.NodeVisitor):
        def visit_Call(self, node: ast.Call) -> None:  # noqa: N802
            if isinstance(node.func, ast.Attribute) and node.func.attr == "_request" and len(node.args) >= 3:
                method_node = node.args[1]
                path_node = node.args[2]
                if isinstance(method_node, ast.Constant) and isinstance(method_node.value, str):
                    method = method_node.value.upper()
                else:
                    return

                if isinstance(path_node, ast.Constant) and isinstance(path_node.value, str):
                    path = path_node.value
                elif isinstance(path_node, ast.JoinedStr):
                    parts: list[str] = []
                    for value in path_node.values:
                        if isinstance(value, ast.Constant):
                            parts.append(str(value.value))
                        else:
                            parts.append("{id}")
                    path = "".join(parts)
                else:
                    return

                routes.add((method, path))

            self.generic_visit(node)

    Visitor().visit(tree)
    return routes


def _server_routes() -> set[tuple[str, str]]:
    root = _repo_root()
    openapi_path = root / "apps" / "api" / "openapi" / "openapi.json"
    server_index = root / "apps" / "api" / "src" / "index.ts"

    data = json.loads(openapi_path.read_text(encoding="utf-8"))
    routes: set[tuple[str, str]] = set()

    for path, methods in data["paths"].items():
        normalized = re.sub(r"\{[^}]+\}", "{id}", path)
        if normalized.startswith("/api"):
            normalized = normalized[4:] or ""
        for method in methods:
            routes.add((method.upper(), normalized))

    source = server_index.read_text(encoding="utf-8")
    for method, path in re.findall(r'app\.(get|post|put|patch|delete)\("(/api(?:/[^"\n]*)?)"', source):
        normalized = path[4:] or ""
        normalized = re.sub(r":[^/]+", "{id}", normalized)
        routes.add((method.upper(), normalized))

    return routes


def test_python_client_covers_server_routes_except_websocket_transport() -> None:
    client_routes = _client_routes()
    server_routes = _server_routes()

    ignored = {("GET", "/stream")}  # websocket route is implemented by stream.py, not REST request wrappers.
    missing = sorted(route for route in server_routes if route not in client_routes and route not in ignored)

    assert not missing, f"missing wrappers for routes: {missing}"
