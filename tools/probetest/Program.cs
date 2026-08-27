// Minimal ASP.NET Core + EF Core app that reproduces the patterns the overlay must
// recognise, so the recorder can be verified end to end without a real application
// or a database server. Everything here is made up.
using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;

var builder = WebApplication.CreateBuilder(args);
builder.Logging.ClearProviders();
builder.Services.AddControllers();
builder.Services.AddDbContext<ShopDb>(options => options.UseSqlite("Data Source=probetest.db"));

var app = builder.Build();

using (var scope = app.Services.CreateScope())
{
    var db = scope.ServiceProvider.GetRequiredService<ShopDb>();
    db.Database.EnsureDeleted();
    db.Database.EnsureCreated();
    for (var i = 0; i < 50; i++)
    {
        db.OrderLines.Add(new OrderLine { Id = i + 1, Sku = $"SKU-{i + 1}", IsConfirmed = true, Quantity = 5 });
    }
    db.Orders.Add(new Order { Id = 1, Reference = "ORD-0001" });
    db.SaveChanges();
}

app.MapControllers();
app.Run("http://127.0.0.1:5599");

public class OrderLine
{
    public int Id { get; set; }
    public string Sku { get; set; }
    public bool IsConfirmed { get; set; }
    public int Quantity { get; set; }
}

public class Order
{
    public int Id { get; set; }
    public string Reference { get; set; }
}

public class ShopDb : DbContext
{
    public ShopDb(DbContextOptions<ShopDb> options) : base(options)
    {
    }

    public DbSet<OrderLine> OrderLines => Set<OrderLine>();
    public DbSet<Order> Orders => Set<Order>();
}

[ApiController]
[Route("api/[controller]/[action]")]
public class OrdersController : ControllerBase
{
    private readonly ShopDb _db;

    public OrdersController(ShopDb db)
    {
        _db = db;
    }

    [HttpPost]
    public async Task<IActionResult> Recalculate()
    {
        var order = await LoadOrder();
        var lines = await _db.OrderLines.ToListAsync();

        await ResetTotals(lines);
        await PersistTotals(lines);

        // the same order row, read a second time for no reason
        await LoadOrder();

        return Ok(new { order?.Reference, lines = lines.Count });
    }

    private async Task<Order> LoadOrder()
    {
        return await _db.Orders.FirstOrDefaultAsync(o => o.Id == 1);
    }

    private async Task ResetTotals(List<OrderLine> lines)
    {
        foreach (var line in lines)
        {
            // N+1: one lookup per line
            var fresh = await _db.OrderLines.AsNoTracking().FirstOrDefaultAsync(l => l.Id == line.Id);
            line.IsConfirmed = false;
            line.Quantity = fresh?.Quantity ?? 0;
        }
        await _db.SaveChangesAsync();
    }

    private async Task PersistTotals(List<OrderLine> lines)
    {
        // second pass over the exact same rows
        foreach (var line in lines)
        {
            line.Quantity = 0;
        }
        await _db.SaveChangesAsync();
    }
}
