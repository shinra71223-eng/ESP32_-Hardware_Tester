import os
import sys
import subprocess
import shutil

def main():
    project_dir = os.path.dirname(os.path.abspath(__file__))
    venv_dir = os.path.join(project_dir, ".venv_build")
    
    print("=== 1. Creating python virtual environment ===")
    if not os.path.exists(venv_dir):
        # Create virtual env using the current system python (py launcher preferred if on Windows)
        python_exe = sys.executable
        print(f"Using python: {python_exe}")
        subprocess.run([python_exe, "-m", "venv", ".venv_build"], check=True)
        print("Virtual environment created.")
    else:
        print("Virtual environment already exists.")
        
    # Paths to python, pip and pyinstaller in venv (Windows specific paths)
    venv_python = os.path.join(venv_dir, "Scripts", "python.exe")
    venv_pip = os.path.join(venv_dir, "Scripts", "pip.exe")
    venv_pyinstaller = os.path.join(venv_dir, "Scripts", "pyinstaller.exe")
    
    # Just in case we are on a non-Windows OS (fallback, though user OS is Windows)
    if not os.path.exists(venv_python):
        venv_python = os.path.join(venv_dir, "bin", "python")
        venv_pip = os.path.join(venv_dir, "bin", "pip")
        venv_pyinstaller = os.path.join(venv_dir, "bin", "pyinstaller")
        
    print("=== 2. Upgrading pip and installing requirements ===")
    subprocess.run([venv_python, "-m", "pip", "install", "--upgrade", "pip"], check=True)
    subprocess.run([venv_pip, "install", "-r", "requirements.txt"], check=True)
    subprocess.run([venv_pip, "install", "pyinstaller"], check=True)
    print("Dependencies and PyInstaller installed successfully.")
    
    print("=== 3. Building ESP32_Tester_GUI (server.py) ===")
    # Build GUI: includes templates, static, src, platformio.ini, partition files, demo directory, demo_builder.py
    gui_args = [
        venv_pyinstaller,
        "--onefile",
        "--name", "ESP32_Tester_GUI",
        "--add-data", "templates;templates",
        "--add-data", "static;static",
        "--add-data", "src;src",
        "--add-data", "platformio.ini;.",
        "--add-data", "partitions_4MB_demo.csv;.",
        "--add-data", "partitions_8MB_demo.csv;.",
        "--add-data", "demo;demo",
        "--add-data", "demo_builder.py;.",
        "--console", # Open console window to see server logs & easily terminate
        "server.py"
    ]
    print("Running:", " ".join(gui_args))
    subprocess.run(gui_args, check=True)
    
    print("=== 4. Building ESP32_Tester_CLI (app.py) ===")
    cli_args = [
        venv_pyinstaller,
        "--onefile",
        "--name", "ESP32_Tester_CLI",
        "--console",
        "app.py"
    ]
    print("Running:", " ".join(cli_args))
    subprocess.run(cli_args, check=True)
    
    print("=== 5. Packaging files for distribution ===")
    dist_package_dir = os.path.join(project_dir, "dist", "ESP32_Hardware_Tester")
    if os.path.exists(dist_package_dir):
        try:
            shutil.rmtree(dist_package_dir)
        except Exception as e:
            print(f"Warning: could not clean {dist_package_dir} ({e}). Overwriting existing files directly.")
    os.makedirs(dist_package_dir, exist_ok=True)
    
    # Copy EXEs
    shutil.copy(os.path.join(project_dir, "dist", "ESP32_Tester_GUI.exe"), dist_package_dir)
    shutil.copy(os.path.join(project_dir, "dist", "ESP32_Tester_CLI.exe"), dist_package_dir)
    
    # Copy README_dist.txt to dist/ESP32_Hardware_Tester/README.txt
    readme_dist_path = os.path.join(project_dir, "dist", "README_dist.txt")
    shutil.copy(readme_dist_path, os.path.join(dist_package_dir, "README.txt"))
    
    print("\n==============================================")
    print("Build complete!")
    print(f"Distribution files are created at: {dist_package_dir}")
    print("You can distribute the 'ESP32_Hardware_Tester' directory as a ZIP file.")
    print("==============================================")

if __name__ == "__main__":
    main()
