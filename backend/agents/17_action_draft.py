from importlib.util import module_from_spec, spec_from_file_location
from pathlib import Path

_file = Path(__file__).resolve().parents[2] / "src" / "agents" / "17_actionDraft.py"
_spec = spec_from_file_location("src.agents.17_actionDraft", _file)
_mod = module_from_spec(_spec)
assert _spec and _spec.loader
_spec.loader.exec_module(_mod)
globals().update({k: getattr(_mod, k) for k in dir(_mod) if not k.startswith("__")})
