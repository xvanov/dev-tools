__version__ = "0.1.0"
__phase__ = "Phase 1"

# Route every `gh` subprocess (ours and agent sessions') through bin/gh so the
# token is chosen by repo owner. See factory/gh_auth.py. FACTORY_GH_SHIM=0 opts out.
from factory.gh_auth import install_shim_on_path as _install_gh_shim  # noqa: E402

_install_gh_shim()
