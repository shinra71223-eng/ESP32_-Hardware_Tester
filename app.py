import os
import sys
import subprocess
import serial.tools.list_ports
import esptool
from rich.console import Console
from rich.table import Table
from rich.panel import Panel
import click

console = Console()

def get_esp32_ports():
    ports = serial.tools.list_ports.comports()
    results = []
    for port in ports:
        # Common identifiers for ESP32 and common USB-Serial bridges
        keywords = ["CP210", "CH340", "USB Serial", "ESP32", "JTAG", "CDC", "UART"]
        is_likely = any(kw.lower() in port.description.lower() for kw in keywords)
        
        # Check VID/PID (Espressif, Silicon Labs, Qinheng, etc.)
        vids = [0x303a, 0x10c4, 0x1a86, 0x0403]
        if port.vid in vids:
            is_likely = True
            
        results.append({
            "port": port,
            "is_likely": is_likely
        })
    return results

def get_chip_info(port):
    try:
        # We use esptool's main function via subprocess to get a clean output for now,
        # or use the internal API if we want to be more integrated.
        # Let's use the command line for simplicity and robustness.
        result = subprocess.run(
            [sys.executable, "-m", "esptool", "--port", port, "flash_id"],
            capture_output=True, text=True, check=True
        )
        return result.stdout
    except Exception as e:
        return f"Error: {str(e)}"

def flash_firmware(port, width, height, pin, color_order, board_env):
    console.print(f"[bold blue]Building and Flashing to {port} (Board: {board_env})...[/bold blue]")
    
    # build_flags as environment variables for PlatformIO
    env = os.environ.copy()
    flags = f"-D LED_WIDTH={width} -D LED_HEIGHT={height} -D LED_PIN={pin} -D COLOR_ORDER={color_order}"
    env["PLATFORMIO_BUILD_FLAGS"] = flags
    
    try:
        # Run PlatformIO upload
        result = subprocess.run(
            ["pio", "run", "-e", board_env, "--target", "upload", "--upload-port", port],
            env=env, capture_output=False
        )
        if result.returncode == 0:
            console.print("[bold green]Success![/bold green]")
        else:
            console.print("[bold red]Flash failed.[/bold red]")
    except Exception as e:
        console.print(f"[bold red]Error:[/bold red] {str(e)}")

@click.group()
def cli():
    """ESP32 Hardware Tester & Manager"""
    pass

@cli.command()
def scan():
    """Scan for connected ESP32 devices"""
    results = get_esp32_ports()
    if not results:
        console.print("[bold red]No serial ports found at all.[/bold red]")
        console.print("[yellow]Check: USB Cable (data), Power, and Device Manager.[/yellow]")
        return

    table = Table(title="Detected Serial Devices")
    table.add_column("Port", style="cyan")
    table.add_column("Description", style="magenta")
    table.add_column("Status", style="green")
    
    for item in results:
        port = item["port"]
        status = "[bold green]Likely ESP32[/bold green]" if item["is_likely"] else "Other Device"
        table.add_row(port.device, port.description, status)
    
    console.print(table)
    if not any(item["is_likely"] for item in results):
        console.print("\n[yellow]Note: No typical ESP32 markers found, but listed all ports above.[/yellow]")

@cli.command()
@click.argument('port')
def info(port):
    """Get detailed chip info and MAC address"""
    console.print(f"Querying [bold cyan]{port}[/bold cyan]...")
    info_text = get_chip_info(port)
    console.print(Panel(info_text, title="Chip Info"))

@cli.command()
@click.option('--port', prompt='Port', help='COM port of the ESP32')
@click.option('--board', default='esp32', type=click.Choice(['esp32', 'esp32s3']), help='Board environment (esp32 or esp32s3)')
@click.option('--width', default=88, help='LED Matrix Width')
@click.option('--height', default=10, help='LED Matrix Height')
@click.option('--pin', default=2, help='Data Pin (Default 2 for plain ESP32)')
@click.option('--order', default='GRB', help='Color Order (GRB, RGB, etc.)')
def deploy(port, board, width, height, pin, order):
    """Build and Flash test firmware with custom mapping"""
    flash_firmware(port, width, height, pin, order, board)

if __name__ == "__main__":
    cli()
