import { LOG_SB16 } from "./const.js";
import { h } from "./lib.js";
import { dbg_log } from "./log.js";

// For Types Only
import { CPU } from "./cpu.js";
import { BusConnector } from "./bus.js";

/**
 * Intel 82801AA (ICH) AC'97 audio controller.
 *
 * Based on:
 * -> https://github.com/qemu/qemu/blob/master/hw/audio/ac97.c
 * -> Intel 82801AA (ICH) datasheet, AC '97 controller registers
 * -> AC '97 Component Specification 2.3 (codec/mixer registers)
 *
 * Audio leaves the device through the same bus protocol as the SB16
 * ("dac-*" events consumed by SpeakerAdapter). Sample data is fetched
 * with bus-master DMA directly from guest physical memory, driven by
 * "dac-request-data" pulls from the audio worklet.
 */

// Native Audio Mixer (codec) registers, BAR0.
const MIXER_RESET = 0x00;
const MIXER_MASTER_VOLUME = 0x02;
const MIXER_AUX_OUT_VOLUME = 0x04;
const MIXER_MONO_VOLUME = 0x06;
const MIXER_PC_BEEP_VOLUME = 0x0A;
const MIXER_PHONE_VOLUME = 0x0C;
const MIXER_MIC_VOLUME = 0x0E;
const MIXER_LINE_IN_VOLUME = 0x10;
const MIXER_CD_VOLUME = 0x12;
const MIXER_VIDEO_VOLUME = 0x14;
const MIXER_AUX_IN_VOLUME = 0x16;
const MIXER_PCM_OUT_VOLUME = 0x18;
const MIXER_RECORD_SELECT = 0x1A;
const MIXER_RECORD_GAIN = 0x1C;
const MIXER_RECORD_GAIN_MIC = 0x1E;
const MIXER_GENERAL_PURPOSE = 0x20;
const MIXER_POWERDOWN_CTRL_STAT = 0x26;
const MIXER_EXTENDED_AUDIO_ID = 0x28;
const MIXER_EXTENDED_AUDIO_CTRL_STAT = 0x2A;
const MIXER_PCM_FRONT_DAC_RATE = 0x2C;
const MIXER_PCM_LR_ADC_RATE = 0x32;
const MIXER_MIC_ADC_RATE = 0x34;
const MIXER_VENDOR_ID1 = 0x7C;
const MIXER_VENDOR_ID2 = 0x7E;

// Extended audio: variable rate audio supported/enabled.
const EAID_VRA = 1 << 0;
const EACS_VRA = 1 << 0;

// Native Audio Bus Master registers, BAR1.
// Three DMA engines: PCM in at 0x00, PCM out at 0x10, mic in at 0x20.
// Register offsets within an engine:
const BM_BDBAR = 0x00;  // dword: buffer descriptor list base address
const BM_CIV = 0x04;    // byte: current index value
const BM_LVI = 0x05;    // byte: last valid index
const BM_SR = 0x06;     // word: status register
const BM_PICB = 0x08;   // word: position in current buffer (in samples)
const BM_PIV = 0x0A;    // byte: prefetched index value
const BM_CR = 0x0B;     // byte: control register

const GLOB_CNT = 0x2C;  // dword: global control
const GLOB_STA = 0x30;  // dword: global status
const CAS = 0x34;       // byte: codec access semaphore

// Status register bits.
const SR_DCH = 0x01;    // DMA controller halted
const SR_CELV = 0x02;   // current equals last valid
const SR_LVBCI = 0x04;  // last valid buffer completion interrupt
const SR_BCIS = 0x08;   // buffer completion interrupt status
const SR_FIFOE = 0x10;  // FIFO error
const SR_RO_MASK = SR_DCH | SR_CELV;
const SR_WCLEAR_MASK = SR_LVBCI | SR_BCIS | SR_FIFOE;
const SR_INT_MASK = SR_LVBCI | SR_BCIS | SR_FIFOE;

// Control register bits.
const CR_RPBM = 0x01;   // run/pause bus master
const CR_RR = 0x02;     // reset registers
const CR_LVBIE = 0x04;  // last valid buffer interrupt enable
const CR_FEIE = 0x08;   // FIFO error interrupt enable
const CR_IOCE = 0x10;   // interrupt on completion enable
const CR_VALID_MASK = CR_RPBM | CR_RR | CR_LVBIE | CR_FEIE | CR_IOCE;

// Global control bits.
const GC_GIE = 0x01;    // GPI interrupt enable
const GC_COLD = 0x02;   // cold reset (0 = reset asserted)
const GC_WARM = 0x04;   // warm reset
const GC_VALID_MASK = 0x3F;

// Global status bits.
const GS_PIINT = 1 << 5;  // PCM in interrupt
const GS_POINT = 1 << 6;  // PCM out interrupt
const GS_MINT = 1 << 7;   // mic in interrupt
const GS_S0CR = 1 << 8;   // primary codec ready

// Buffer descriptor control bits (high word of the second dword).
const BD_IOC = 1 << 31 >>> 0;  // interrupt on completion
const BD_BUP = 1 << 30;        // buffer underrun policy

const BDL_ENTRIES = 32;

// Engine indices.
const PI = 0;  // PCM in
const PO = 1;  // PCM out
const MC = 2;  // mic in

// Samples (16-bit words) transferred from the current buffer per
// dac-request-data pull. Must be even (stereo frames).
const TRANSFER_SAMPLES = 2048;

const AC97_IO_NAM = 0x2000;   // BAR0 default base
const AC97_IO_NABM = 0x2100;  // BAR1 default base


/**
 * One bus-master DMA engine (PCM in / PCM out / mic in).
 * @constructor
 */
function AC97BM()
{
    this.bdbar = 0;
    this.civ = 0;
    this.lvi = 0;
    this.sr = SR_DCH;
    this.picb = 0;
    this.piv = 0;
    this.cr = 0;

    // Physical address and remaining samples of the buffer currently
    // being transferred (refreshed from the BDL when a buffer is fetched).
    this.buffer_addr = 0;
    this.buffer_ioc = false;
}

AC97BM.prototype.reset = function()
{
    this.bdbar = 0;
    this.civ = 0;
    this.lvi = 0;
    this.sr = SR_DCH;
    this.picb = 0;
    this.piv = 0;
    this.cr = this.cr & (CR_LVBIE | CR_FEIE | CR_IOCE);
    this.buffer_addr = 0;
    this.buffer_ioc = false;
};

AC97BM.prototype.get_state = function()
{
    return [
        this.bdbar,
        this.civ,
        this.lvi,
        this.sr,
        this.picb,
        this.piv,
        this.cr,
        this.buffer_addr,
        this.buffer_ioc,
    ];
};

AC97BM.prototype.set_state = function(state)
{
    this.bdbar = state[0];
    this.civ = state[1];
    this.lvi = state[2];
    this.sr = state[3];
    this.picb = state[4];
    this.piv = state[5];
    this.cr = state[6];
    this.buffer_addr = state[7];
    this.buffer_ioc = state[8];
};


/**
 * @constructor
 * @param {CPU} cpu
 * @param {BusConnector} bus
 */
export function AC97(cpu, bus)
{
    /** @const @type {CPU} */
    this.cpu = cpu;

    /** @const @type {BusConnector} */
    this.bus = bus;

    this.pci = cpu.devices.pci;

    this.name = "ac97";
    this.pci_id = 0x0D << 3;
    this.pci_space = [
        // vendor 0x8086 (Intel), device 0x2415 (82801AA AC'97 Audio)
        0x86, 0x80, 0x15, 0x24,
        // command: I/O space + bus master, status
        0x05, 0x00, 0x80, 0x02,
        // revision 1, prog-if, subclass 0x01 (audio), class 0x04 (multimedia)
        0x01, 0x00, 0x01, 0x04,
        0x00, 0x00, 0x00, 0x00,
        // BAR0: NAM (mixer) I/O
        AC97_IO_NAM & 0xFF | 1, AC97_IO_NAM >> 8, 0x00, 0x00,
        // BAR1: NABM (bus master) I/O
        AC97_IO_NABM & 0xFF | 1, AC97_IO_NABM >> 8, 0x00, 0x00,
        0x00, 0x00, 0x00, 0x00,
        0x00, 0x00, 0x00, 0x00,
        0x00, 0x00, 0x00, 0x00,
        0x00, 0x00, 0x00, 0x00,
        0x00, 0x00, 0x00, 0x00,
        // subsystem vendor / subsystem id
        0x86, 0x80, 0x15, 0x24,
        0x00, 0x00, 0x00, 0x00,
        0x00, 0x00, 0x00, 0x00,
        0x00, 0x00, 0x00, 0x00,
        // interrupt line, pin INTA
        0x00, 0x01, 0x00, 0x00,
    ];
    this.pci_bars = [
        {
            size: 256,
        },
        {
            size: 256,
        },
    ];

    this.mixer_registers = new Uint16Array(0x80 >> 1);

    this.bm = [new AC97BM(), new AC97BM(), new AC97BM()];

    this.glob_cnt = GC_COLD;
    this.glob_sta = GS_S0CR;
    this.cas = 0;

    this.sampling_rate = 48000;
    this.dac_enabled = false;

    for(let i = 0; i < 0x80; i += 2)
    {
        cpu.io.register_read(AC97_IO_NAM + i, this,
            this.nam_read16.bind(this, i),
            this.nam_read16.bind(this, i),
            undefined);
        cpu.io.register_write(AC97_IO_NAM + i, this,
            undefined,
            this.nam_write16.bind(this, i),
            undefined);
    }

    for(let i = 0; i < 0x40; i++)
    {
        cpu.io.register_read(AC97_IO_NABM + i, this,
            this.nabm_read8.bind(this, i),
            i % 2 === 0 ? this.nabm_read16.bind(this, i) : undefined,
            i % 4 === 0 ? this.nabm_read32.bind(this, i) : undefined);
        cpu.io.register_write(AC97_IO_NABM + i, this,
            this.nabm_write8.bind(this, i),
            i % 2 === 0 ? this.nabm_write16.bind(this, i) : undefined,
            i % 4 === 0 ? this.nabm_write32.bind(this, i) : undefined);
    }

    cpu.devices.pci.register_device(this);

    bus.register("dac-request-data", function()
    {
        this.dac_handle_request();
    }, this);
    bus.register("speaker-has-initialized", function()
    {
        this.bus.send("dac-tell-sampling-rate", this.sampling_rate);
    }, this);
    bus.send("speaker-confirm-initialized");

    this.mixer_reset();

    dbg_log("AC97 initialized: NAM=" + h(AC97_IO_NAM) + " NABM=" + h(AC97_IO_NABM), LOG_SB16);
}

AC97.prototype.get_state = function()
{
    return [
        this.mixer_registers,
        this.bm[PI].get_state(),
        this.bm[PO].get_state(),
        this.bm[MC].get_state(),
        this.glob_cnt,
        this.glob_sta,
        this.cas,
        this.sampling_rate,
        this.dac_enabled,
    ];
};

AC97.prototype.set_state = function(state)
{
    this.mixer_registers.set(state[0]);
    this.bm[PI].set_state(state[1]);
    this.bm[PO].set_state(state[2]);
    this.bm[MC].set_state(state[3]);
    this.glob_cnt = state[4];
    this.glob_sta = state[5];
    this.cas = state[6];
    this.sampling_rate = state[7];
    this.dac_enabled = state[8];

    this.bus.send("dac-tell-sampling-rate", this.sampling_rate);
    if(this.dac_enabled)
    {
        this.bus.send("dac-enable");
    }
    else
    {
        this.bus.send("dac-disable");
    }
};

//
// Codec mixer
//

AC97.prototype.mixer_reset = function()
{
    this.mixer_registers.fill(0);

    this.mixer_store(MIXER_RESET, 0x0000);
    this.mixer_store(MIXER_MASTER_VOLUME, 0x8000);
    this.mixer_store(MIXER_AUX_OUT_VOLUME, 0x8000);
    this.mixer_store(MIXER_MONO_VOLUME, 0x8000);
    this.mixer_store(MIXER_PC_BEEP_VOLUME, 0x0000);
    this.mixer_store(MIXER_PHONE_VOLUME, 0x8008);
    this.mixer_store(MIXER_MIC_VOLUME, 0x8008);
    this.mixer_store(MIXER_LINE_IN_VOLUME, 0x8808);
    this.mixer_store(MIXER_CD_VOLUME, 0x8808);
    this.mixer_store(MIXER_VIDEO_VOLUME, 0x8808);
    this.mixer_store(MIXER_AUX_IN_VOLUME, 0x8808);
    this.mixer_store(MIXER_PCM_OUT_VOLUME, 0x8808);
    this.mixer_store(MIXER_RECORD_SELECT, 0x0000);
    this.mixer_store(MIXER_RECORD_GAIN, 0x8000);
    this.mixer_store(MIXER_RECORD_GAIN_MIC, 0x8000);
    this.mixer_store(MIXER_GENERAL_PURPOSE, 0x0000);
    // ADC/DAC/analog/reference all ready
    this.mixer_store(MIXER_POWERDOWN_CTRL_STAT, 0x000F);
    this.mixer_store(MIXER_EXTENDED_AUDIO_ID, EAID_VRA);
    this.mixer_store(MIXER_EXTENDED_AUDIO_CTRL_STAT, EACS_VRA);
    this.mixer_store(MIXER_PCM_FRONT_DAC_RATE, 48000);
    this.mixer_store(MIXER_PCM_LR_ADC_RATE, 48000);
    this.mixer_store(MIXER_MIC_ADC_RATE, 48000);
    // SigmaTel STAC9700
    this.mixer_store(MIXER_VENDOR_ID1, 0x8384);
    this.mixer_store(MIXER_VENDOR_ID2, 0x7600);

    this.set_sampling_rate(48000);
};

AC97.prototype.mixer_store = function(reg, value)
{
    this.mixer_registers[reg >> 1] = value;
};

AC97.prototype.mixer_load = function(reg)
{
    return this.mixer_registers[reg >> 1];
};

AC97.prototype.nam_read16 = function(reg)
{
    this.cas = 0;
    dbg_log("ac97 nam read " + h(reg) + " -> " + h(this.mixer_load(reg), 4), LOG_SB16);
    return this.mixer_load(reg);
};

AC97.prototype.nam_write16 = function(reg, value)
{
    this.cas = 0;
    dbg_log("ac97 nam write " + h(reg) + " <- " + h(value, 4), LOG_SB16);

    switch(reg)
    {
        case MIXER_RESET:
            this.mixer_reset();
            break;

        case MIXER_POWERDOWN_CTRL_STAT:
            // Preserve the read-only ready bits.
            this.mixer_store(reg, value & ~0x800F | this.mixer_load(reg) & 0x000F);
            break;

        case MIXER_EXTENDED_AUDIO_ID:
        case MIXER_VENDOR_ID1:
        case MIXER_VENDOR_ID2:
            // Read-only.
            break;

        case MIXER_EXTENDED_AUDIO_CTRL_STAT:
            this.mixer_store(reg, value & EACS_VRA);
            if(!(value & EACS_VRA))
            {
                this.mixer_store(MIXER_PCM_FRONT_DAC_RATE, 48000);
                this.mixer_store(MIXER_PCM_LR_ADC_RATE, 48000);
                this.set_sampling_rate(48000);
            }
            break;

        case MIXER_PCM_FRONT_DAC_RATE:
            if(this.mixer_load(MIXER_EXTENDED_AUDIO_CTRL_STAT) & EACS_VRA)
            {
                this.mixer_store(reg, value);
                this.set_sampling_rate(value);
            }
            break;

        default:
            this.mixer_store(reg, value);
            break;
    }
};

AC97.prototype.set_sampling_rate = function(rate)
{
    dbg_log("ac97 sampling rate: " + rate, LOG_SB16);
    this.sampling_rate = rate;
    this.bus.send("dac-tell-sampling-rate", rate);
};

//
// Bus master
//

AC97.prototype.nabm_read8 = function(addr)
{
    if(addr === CAS)
    {
        const value = this.cas;
        this.cas = 1;
        return value;
    }

    const r = this.bm_reg(addr);
    if(!r)
    {
        return this.nabm_global_read(addr) & 0xFF;
    }
    const bm = r[0];
    switch(r[1])
    {
        case BM_CIV: return bm.civ;
        case BM_LVI: return bm.lvi;
        case BM_SR: return bm.sr & 0xFF;
        case BM_PIV: return bm.piv;
        case BM_CR: return bm.cr;
        default:
            dbg_log("ac97 nabm read8 unhandled: " + h(addr), LOG_SB16);
            return 0;
    }
};

AC97.prototype.nabm_read16 = function(addr)
{
    const r = this.bm_reg(addr);
    if(!r)
    {
        return this.nabm_global_read(addr) & 0xFFFF;
    }
    const bm = r[0];
    switch(r[1])
    {
        case BM_SR: return bm.sr;
        case BM_PICB: return bm.picb;
        default:
            return this.nabm_read8(addr) | this.nabm_read8(addr + 1) << 8;
    }
};

AC97.prototype.nabm_read32 = function(addr)
{
    const r = this.bm_reg(addr);
    if(!r)
    {
        return this.nabm_global_read(addr);
    }
    const bm = r[0];
    switch(r[1])
    {
        case BM_BDBAR: return bm.bdbar;
        case BM_CIV:
            // CIV | LVI << 8 | SR << 16, as on real hardware
            return bm.civ | bm.lvi << 8 | bm.sr << 16;
        case BM_PICB:
            return bm.picb | bm.piv << 16 | bm.cr << 24;
        default:
            dbg_log("ac97 nabm read32 unhandled: " + h(addr), LOG_SB16);
            return 0;
    }
};

AC97.prototype.nabm_global_read = function(addr)
{
    switch(addr)
    {
        case GLOB_CNT: return this.glob_cnt;
        case GLOB_STA: return this.glob_sta;
        default:
            dbg_log("ac97 nabm global read unhandled: " + h(addr), LOG_SB16);
            return 0;
    }
};

AC97.prototype.nabm_write8 = function(addr, value)
{
    const r = this.bm_reg(addr);
    if(!r)
    {
        this.nabm_global_write(addr, value);
        return;
    }
    const bm = r[0];
    const index = this.bm.indexOf(bm);
    switch(r[1])
    {
        case BM_LVI:
            bm.lvi = value & (BDL_ENTRIES - 1);
            if((bm.cr & CR_RPBM) && (bm.sr & SR_DCH))
            {
                // Engine was waiting at last valid buffer; new buffers arrived.
                bm.sr &= ~(SR_DCH | SR_CELV);
                if(index === PO)
                {
                    this.po_fetch_buffer();
                }
            }
            break;
        case BM_CIV:
            // Read-only.
            break;
        case BM_SR:
            bm.sr &= ~(value & SR_WCLEAR_MASK);
            this.update_interrupts(index);
            break;
        case BM_CR:
            this.bm_control(index, value);
            break;
        default:
            dbg_log("ac97 nabm write8 unhandled: " + h(addr) + " <- " + h(value), LOG_SB16);
            break;
    }
};

AC97.prototype.nabm_write16 = function(addr, value)
{
    const r = this.bm_reg(addr);
    if(r && r[1] === BM_SR)
    {
        this.nabm_write8(addr, value & 0xFF);
        return;
    }
    if(!r)
    {
        this.nabm_global_write(addr, value);
        return;
    }
    dbg_log("ac97 nabm write16 unhandled: " + h(addr) + " <- " + h(value, 4), LOG_SB16);
};

AC97.prototype.nabm_write32 = function(addr, value)
{
    const r = this.bm_reg(addr);
    if(!r)
    {
        this.nabm_global_write(addr, value);
        return;
    }
    const bm = r[0];
    if(r[1] === BM_BDBAR)
    {
        bm.bdbar = value & ~7;
        dbg_log("ac97 bdbar[" + this.bm.indexOf(bm) + "] = " + h(bm.bdbar >>> 0, 8), LOG_SB16);
    }
    else
    {
        dbg_log("ac97 nabm write32 unhandled: " + h(addr) + " <- " + h(value >>> 0, 8), LOG_SB16);
    }
};

AC97.prototype.nabm_global_write = function(addr, value)
{
    switch(addr)
    {
        case GLOB_CNT:
            if(value & GC_WARM)
            {
                // Warm reset: self-clearing, codec stays ready.
                value &= ~GC_WARM;
            }
            if(!(value & GC_COLD))
            {
                this.device_reset();
                // Cold reset bit reads back as written; codec becomes
                // ready again immediately.
                this.glob_sta = GS_S0CR;
            }
            this.glob_cnt = value & GC_VALID_MASK;
            break;
        case GLOB_STA:
            // Interrupt bits in GLOB_STA follow the engines' SR bits and
            // are cleared by clearing those; writes here are ignored.
            break;
        default:
            dbg_log("ac97 nabm global write unhandled: " + h(addr) + " <- " + h(value >>> 0), LOG_SB16);
            break;
    }
};

/**
 * Map a NABM register offset to [engine, register-within-engine],
 * or null for the global registers.
 */
AC97.prototype.bm_reg = function(addr)
{
    if(addr < 0x30)
    {
        return [this.bm[addr >> 4], addr & 0x0F];
    }
    return null;
};

AC97.prototype.bm_control = function(index, value)
{
    const bm = this.bm[index];

    if(value & CR_RR)
    {
        bm.reset();
        this.update_interrupts(index);
        if(index === PO)
        {
            this.dac_disable();
        }
        return;
    }

    const was_running = bm.cr & CR_RPBM;
    bm.cr = value & CR_VALID_MASK;

    if(!(bm.cr & CR_RPBM))
    {
        if(was_running)
        {
            bm.sr |= SR_DCH;
            if(index === PO)
            {
                this.dac_disable();
            }
        }
    }
    else if(!was_running)
    {
        bm.sr &= ~SR_DCH;
        if(index === PO)
        {
            bm.civ = bm.piv = 0;
            this.po_fetch_buffer();
            this.dac_enable();
        }
        else
        {
            // Recording engines are not implemented; report the last
            // valid buffer as immediately consumed so drivers that
            // start capture do not hang forever.
            bm.civ = bm.lvi;
            bm.picb = 0;
            bm.sr |= SR_DCH | SR_CELV | SR_LVBCI;
            this.update_interrupts(index);
        }
    }
};

/**
 * Load the descriptor at CIV of the PCM out engine into
 * buffer_addr/picb.
 */
AC97.prototype.po_fetch_buffer = function()
{
    const bm = this.bm[PO];
    const entry_addr = (bm.bdbar + bm.civ * 8) >>> 0;
    const addr = this.cpu.read32s(entry_addr) & ~1;
    const control = this.cpu.read32s(entry_addr + 4);

    bm.buffer_addr = addr >>> 0;
    bm.picb = control & 0xFFFF;
    bm.buffer_ioc = (control & BD_IOC) !== 0;
    bm.piv = bm.civ + 1 & BDL_ENTRIES - 1;

    dbg_log("ac97 po buffer[" + bm.civ + "] addr=" + h(bm.buffer_addr, 8) +
        " samples=" + bm.picb + " ioc=" + bm.buffer_ioc, LOG_SB16);
};

/**
 * Called when the current PCM out buffer has been fully transferred.
 */
AC97.prototype.po_buffer_completed = function()
{
    const bm = this.bm[PO];

    if(bm.buffer_ioc)
    {
        bm.sr |= SR_BCIS;
    }

    if(bm.civ === bm.lvi)
    {
        // Out of buffers: halt until the driver moves LVI forward.
        bm.sr |= SR_LVBCI | SR_DCH | SR_CELV;
    }
    else
    {
        bm.civ = bm.civ + 1 & BDL_ENTRIES - 1;
        this.po_fetch_buffer();
    }

    this.update_interrupts(PO);
};

//
// Interrupts
//

AC97.prototype.update_interrupts = function(index)
{
    const bm = this.bm[index];
    const gs_bits = [GS_PIINT, GS_POINT, GS_MINT];

    const level =
        (bm.sr & SR_BCIS) && (bm.cr & CR_IOCE) ||
        (bm.sr & SR_LVBCI) && (bm.cr & CR_LVBIE) ||
        (bm.sr & SR_FIFOE) && (bm.cr & CR_FEIE);

    if(level)
    {
        this.glob_sta |= gs_bits[index];
    }
    else
    {
        this.glob_sta &= ~gs_bits[index];
    }

    if(this.glob_sta & (GS_PIINT | GS_POINT | GS_MINT))
    {
        this.pci.raise_irq(this.pci_id);
    }
    else
    {
        this.pci.lower_irq(this.pci_id);
    }
};

//
// Audio output
//

AC97.prototype.dac_enable = function()
{
    if(!this.dac_enabled)
    {
        this.dac_enabled = true;
        this.bus.send("dac-tell-sampling-rate", this.sampling_rate);
        this.bus.send("dac-enable");
    }
};

AC97.prototype.dac_disable = function()
{
    if(this.dac_enabled)
    {
        this.dac_enabled = false;
        this.bus.send("dac-disable");
    }
};

/**
 * Pull handler: the audio worklet is running low, transfer the next
 * chunk of the current buffer out of guest memory.
 */
AC97.prototype.dac_handle_request = function()
{
    const bm = this.bm[PO];

    if(!(bm.cr & CR_RPBM) || (bm.sr & SR_DCH) || !bm.picb)
    {
        // Not running or between buffers: send silence to keep the
        // worklet fed, mirroring real hardware underrun behaviour.
        const silence = new Float32Array(TRANSFER_SAMPLES >> 1);
        this.bus.send("dac-send-data", [silence, silence]);
        return;
    }

    const samples = Math.min(bm.picb, TRANSFER_SAMPLES) & ~1;
    const bytes = samples << 1;
    const data = this.cpu.read_blob(bm.buffer_addr, bytes);
    const data16 = new Int16Array(data.buffer, data.byteOffset, samples);

    const frames = samples >> 1;
    const out0 = new Float32Array(frames);
    const out1 = new Float32Array(frames);
    for(let i = 0; i < frames; i++)
    {
        out0[i] = data16[i << 1] / 0x8000;
        out1[i] = data16[(i << 1) + 1] / 0x8000;
    }
    this.bus.send("dac-send-data", [out0, out1], [out0.buffer, out1.buffer]);

    bm.buffer_addr = bm.buffer_addr + bytes >>> 0;
    bm.picb -= samples;

    if(bm.picb === 0)
    {
        this.po_buffer_completed();
    }
};

AC97.prototype.device_reset = function()
{
    for(let i = 0; i < 3; i++)
    {
        this.bm[i].reset();
        this.update_interrupts(i);
    }
    this.mixer_reset();
    this.dac_disable();
};
