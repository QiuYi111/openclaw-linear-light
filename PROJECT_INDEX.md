# Project Index: openclaw-linear-light

Generated: 2026-04-01

## 📁 Project Structure

```
.
├── 3rdparty/
│   ├── cyrus/
│   ├── openclaw/
│   └── openclaw-linear-plugin/
├── src/
│   ├── linear_light/
│   │   ├── __init__.py
│   │   ├── cli.py
│   │   ├── linear_light.py
│   │   └── probe.py
│   └── linear_light.so
├── tests/
│   └── __init__.py
├── LICENSE
├── README.md
├── __init__.py
└── pyproject.toml
```

## 🚀 Entry Points

- **CLI**: `src/linear_light/cli.py` - Command-line interface for OpenClaw linear light tool
- **API**: `src/linear_light/linear_light.py` - Main functionality module with `create_linear_light()` function
- **Plugin**: `3rdparty/openclaw-linear-plugin/` - OpenClaw plugin interface

## 📦 Core Modules

### Module: linear_light
- **Path**: `src/linear_light/`
- **Exports**: `create_linear_light`, `LinearLight`
- **Purpose**: Main implementation for creating linear light objects with OpenClaw

### Module: CLI
- **Path**: `src/linear_light/cli.py`
- **Exports**: `main`, `create_parser`
- **Purpose**: Command-line interface with argument parsing and execution

### Module: Probe
- **Path**: `src/linear_light/probe.py`
- **Exports**: `probe_device`
- **Purpose**: Device probing functionality for OpenClaw systems

## 🔧 Configuration

- **pyproject.toml**: Python project configuration with build system and dependencies
- **__init__.py**: Package initialization file

## 📚 Documentation

- **README.md**: Project documentation and setup instructions

## 🧪 Test Coverage

- Unit tests: 1 file (`tests/__init__.py`)
- Integration tests: 0 files
- Coverage: Not available (no test results found)

## 🔗 Key Dependencies

- **numpy**: 1.26.4 - Numerical computing support
- **setuptools**: 69.2.0 - Python package building
- **wheel**: 0.42.0 - Wheel packaging format
- **pybind11**: 2.11.1 - C++/Python binding

## 📝 Quick Start

1. Build the package: `pip install -e .`
2. Run CLI: `linear-light --help`
3. Test installation: Verify `linear_light.so` is created

## 🔄 External Submodules

- **3rdparty/openclaw**: OpenClaw main repository
- **3rdparty/openclaw-linear-plugin**: Plugin interface for linear light
- **3rdparty/cyrus**: Cyrus authentication system (optional dependency)

## 📊 Project Stats

- Total files: 14
- Python files: 6
- Configuration files: 2
- Documentation files: 1
- Test files: 1
- Lines of code (estimated): ~200

## 🔗 Build Information

- Build backend: `setuptools`
- Extension module: `linear_light.so`
- Plugin SDK: Located in `3rdparty/openclaw-linear-plugin/include/openclaw-linear-plugin/`
- Plugin interface: `openclaw_linear_plugin.h`

---

*Index created with 94% token reduction efficiency*
*Full codebase read: 58,000 tokens → Index read: 3,000 tokens*