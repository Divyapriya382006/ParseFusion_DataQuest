import sys
from importlib.util import module_from_spec, spec_from_file_location
from pathlib import Path

_file = Path(__file__).resolve().parents[2] / "src" / "agents" / "14_caseLinker.py"
_spec = spec_from_file_location("src.agents.14_caseLinker", _file)
if _spec is None or _spec.loader is None:
    raise ImportError(f"Unable to load agent module from {_file}")
_mod = module_from_spec(_spec)
sys.modules[_spec.name] = _mod
_spec.loader.exec_module(_mod)
globals().update({k: getattr(_mod, k) for k in dir(_mod) if not k.startswith("__")})
__all__ = [k for k in dir(_mod) if not k.startswith("__")]
